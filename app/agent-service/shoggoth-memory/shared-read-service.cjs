"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { serviceError } = require("../security");
const { OwnerMemoryReader } = require("./owner-memory-reader.cjs");
const { normalizeBorrowedMemoryRefs, mergeBorrowedMemoryRefs, extractBorrowedMemoryRefs } = require("./borrowed-memory-provenance.cjs");
const fail = (code, message) => { throw serviceError(code, message); };
const ACCESS_PREFIX = "shared-memory:";
const ACCESS_TTL = 10 * 60_000;
const MAX_ACCESS = 4096;
const MAX_REQUEST_MS = 30_000;
const MAX_RESPONSE_BYTES = 48 * 1024;
const REQUEST_SCOPE = Symbol("shared-memory-request");
// Active Memory prepares the authenticated chat context before durable Runtime
// admission. That queued WorkRun still has a verified Profile/session/workspace;
// terminal, forged and non-chat runs cannot borrow.
const ACTIVE_RUN_STATUSES = new Set(["queued", "starting", "running", "waiting_approval", "waiting_input"]);
const normalize = text => text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
function suppressionTexts(text) {
  return [...new Set([text, ...text.split("\n").filter(line => line.trim() && !/^\s*(?:#|<!--)/u.test(line))]
    .flatMap(value => [value, value.replace(/^\s*[-*+]\s+/u, "")]).map(normalize).filter(Boolean))];
}
const unavailable = error => ({ code: /^MEMORY_[A-Z_]+$/u.test(error?.code || "") ? error.code : "MEMORY_SHARED_SOURCE_UNAVAILABLE" });

// The source owns every byte and every index entry. Only bounded, run-bound
// access capabilities and body-free dependencies are retained by this broker.
class SharedReadService {
  constructor(service, { config, reader = new OwnerMemoryReader(service) } = {}) {
    this.service = service; this.config = config; this.reader = reader;
    this.access = new Map(); this.runs = new Map(); this.requests = new Map(); this.onRevoked = null; this.onBorrowed = null; this.timer = null;
  }
  setConfig(config) { this.config = config; }
  interactive(input) {
    const run = input?.run;
    if (!run || run.source !== "chat" || run.profileId !== input.profileId || run.workspace !== input.workspace
      || typeof run.id !== "string" || !run.id || /^shoggoth:chat-send:(?:federation-(?:send|message)|group-(?:turn|task))-/u.test(run.idempotencyKey || "")) return false;
    const trusted = this.service.resolveRun?.(run.id);
    if (this.service.resolveRun && (!trusted || trusted.profileId !== run.profileId || trusted.source !== run.source
      || trusted.sourceId !== run.sourceId || trusted.workspace !== run.workspace || trusted.idempotencyKey !== run.idempotencyKey
      || !ACTIVE_RUN_STATUSES.has(trusted.status))) return false;
    const session = this.service.chatSessionStore.listSessions().find(value => value.profileId === run.profileId && (value.id === run.sourceId || value.sessionKey === run.sourceId));
    return Boolean(session && session.workspace === run.workspace && !session.cronOrigin
      && (!input.sessionId || input.sessionId === session.id || input.sessionId === session.sessionKey));
  }
  policy(input) {
    if (!this.interactive(input)) return { revision: 0, enabled: false, participatingProfileIds: [] };
    const state = this.runs.get(input.run.id);
    if (state?.revoked) fail("MEMORY_SHARED_SOURCE_REVOKED", "借阅来源已撤回，本轮回答已停止");
    return this.config?.resolve(input.profileId, this.service.profiles()) || { revision: 0, enabled: false, participatingProfileIds: [] };
  }
  sourceInput(input, ownerProfileId) {
    return { ownerProfileId, requesterProfileId: input.profileId, workspace: input.workspace,
      maxSensitivity: input.maxSensitivity, signal: input.signal, assertCurrent: () => {
        input.signal?.throwIfAborted(); input.assertCurrent?.();
        const policy = this.policy(input);
        if (!policy.enabled || !policy.participatingProfileIds.includes(ownerProfileId)) {
          fail("MEMORY_SHARED_SOURCE_REVOKED", "助理已退出记忆互查");
        }
      } };
  }
  suppressed(profileId, evidence) {
    this.service.database.open();
    const db = this.service.database.db;
    db.exec("CREATE TABLE IF NOT EXISTS memory_borrowed_suppressions (profile_id TEXT NOT NULL, source_hash TEXT NOT NULL, operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(profile_id,source_hash)) STRICT");
    db.exec("CREATE TABLE IF NOT EXISTS memory_borrowed_content_suppressions (profile_id TEXT NOT NULL, content_hash TEXT NOT NULL, text_length INTEGER NOT NULL, operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(profile_id,content_hash)) STRICT");
    const hashes = [evidence.sourceHash];
    const items = this.service.store.list(evidence.ownerProfileId, { status: "active" }).filter(item => item.memoryPath === evidence.canonicalRelativePath
      && item.startLine <= evidence.endLine && item.endLine >= evidence.startLine);
    for (const item of items) hashes.push(require("../memory-engine").contentHash(item.content));
    if (hashes.some(hash => db.prepare("SELECT 1 FROM memory_borrowed_suppressions WHERE profile_id=? AND source_hash=?").get(profileId, hash))) return true;
    const rows = db.prepare("SELECT content_hash,text_length FROM memory_borrowed_content_suppressions WHERE profile_id=?").all(profileId);
    if (!rows.length) return false;
    const candidates = [...new Set([evidence.snippet || "", ...items.map(item => item.authorityText || item.content)].map(normalize))];
    const byLength = new Map();
    for (const row of rows) {
      if (!Number.isSafeInteger(row.text_length) || row.text_length < 1 || !/^[a-f0-9]{64}$/u.test(row.content_hash)) return true;
      if (!byLength.has(row.text_length)) byLength.set(row.text_length, new Set());
      byLength.get(row.text_length).add(row.content_hash);
    }
    // Body-free substring checks preserve forget semantics when a source adds
    // neighboring facts or reflows lines. Bound the work, fail closed on abuse.
    let budget = 100_000;
    for (const text of candidates) for (const [length, blocked] of byLength) {
      if (length > text.length) continue;
      for (let offset = 0; offset <= text.length - length; offset++) {
        if (--budget < 0) return true;
        if (blocked.has(digest(text.slice(offset, offset + length)))) return true;
      }
    }
    return false;
  }
  dependency(input, evidence, revision) {
    const owner = this.service.profiles().find(profile => profile.id === evidence.ownerProfileId);
    return normalizeBorrowedMemoryRefs([{ version: 1, requesterProfileId: input.profileId,
      ownerProfileId: evidence.ownerProfileId, ownerDisplayName: owner?.name || evidence.ownerProfileId,
      canonicalRelativePath: evidence.canonicalRelativePath, documentKind: evidence.documentKind,
      startLine: evidence.startLine, endLine: evidence.endLine, sourceHash: evidence.sourceHash,
      sourceRevision: evidence.sourceRevision, policyRevision: revision,
      ...(evidence.sourceOriginHash ? { sourceOriginHash: evidence.sourceOriginHash } : {}) }])[0];
  }
  issue(input, evidence, policy) {
    this.prune();
    if (this.access.size >= MAX_ACCESS) fail("MEMORY_SHARED_REFERENCE_LIMIT", "本轮借阅引用过多，请缩小查询范围");
    const id = `${ACCESS_PREFIX}${crypto.randomUUID()}`, virtualPath = `shared/${id.slice(ACCESS_PREFIX.length)}/${path.posix.basename(evidence.canonicalRelativePath)}`;
    const dependency = this.dependency(input, evidence, policy.revision);
    const reference = { id, virtualPath, runId: input.run.id, profileId: input.profileId, workspace: input.workspace,
      maxSensitivity: input.maxSensitivity, expiresAt: this.service.now() + ACCESS_TTL, dependency };
    this.access.set(id, reference); this.access.set(virtualPath, reference);
    return { path: virtualPath, id, sourceRef: id, source: "memory", score: evidence.score ?? 0,
      ...dependency, borrowed: true, persistPolicy: "reference_only", snippet: evidence.snippet,
      ...Object.fromEntries(["importance", "triggers", "projectKey", "provenance"].filter(key => evidence[key] !== undefined).map(key => [key, structuredClone(evidence[key])])),
      citation: `${dependency.ownerDisplayName} · ${evidence.citation}`, borrowedMemoryRefs: [dependency] };
  }
  prune() {
    for (const [key, reference] of this.access) if (reference.expiresAt <= this.service.now()) this.access.delete(key);
  }
  recognizes(value) { return typeof value === "string" && (value.startsWith(ACCESS_PREFIX) || value.startsWith("shared/")); }
  reference(input, id) {
    this.policy(input); this.prune();
    const reference = this.access.get(id);
    if (!reference || reference.profileId !== input.profileId || reference.runId !== input.run?.id
      || reference.workspace !== input.workspace || reference.maxSensitivity !== input.maxSensitivity) {
      fail("MEMORY_SHARED_REFERENCE_INVALID", "借阅引用已过期或不属于当前对话，请重新检索");
    }
    const policy = this.policy(input), dep = reference.dependency;
    if (!policy.enabled || !policy.participatingProfileIds.includes(dep.ownerProfileId)) fail("MEMORY_SHARED_SOURCE_REVOKED", "借阅权限已撤回");
    return reference;
  }
  validateReference(input, id) {
    const reference = this.reference(input, id), dep = reference.dependency;
    const current = this.reader.revalidate(this.sourceInput(input, dep.ownerProfileId), dep);
    if (this.suppressed(input.profileId, current)) fail("MEMORY_SHARED_SOURCE_REVOKED", "此内容已在当前助理中屏蔽");
    return { reference, current };
  }
  async withRequest(input, action) {
    if (input[REQUEST_SCOPE] === this || !this.interactive(input)) return action(input);
    const controller = new AbortController(), runId = input.run.id;
    const pending = this.requests.get(runId) || new Set();
    pending.add(controller); this.requests.set(runId, pending);
    const signals = [controller.signal, input.signal, this.service.profileSignal?.(input.profileId)].filter(Boolean);
    const scoped = { ...input, [REQUEST_SCOPE]: this, signal: AbortSignal.any(signals) };
    try {
      scoped.signal.throwIfAborted();
      this.assertRunCurrent(runId);
      const result = await action(scoped);
      scoped.signal.throwIfAborted();
      return result;
    } finally {
      pending.delete(controller);
      if (!pending.size && this.requests.get(runId) === pending) this.requests.delete(runId);
    }
  }
  search(input, own) { return this.withRequest(input, scoped => this.searchSources(scoped, own)); }
  async searchSources(input, own) {
    const policy = this.policy(input);
    if (!policy.enabled || input.memoryScope === "own"
      || Array.isArray(input.sources) && !input.sources.includes("memory")) return own;
    if (!["normal", "private"].includes(input.maxSensitivity)) fail("MEMORY_SHARED_READ_INVALID", "借阅敏感度范围无效");
    const owners = policy.participatingProfileIds.filter(id => id !== input.profileId && (!input.ownerProfileId || id === input.ownerProfileId));
    if (input.ownerProfileId && !policy.participatingProfileIds.includes(input.ownerProfileId)) fail("MEMORY_SHARED_SOURCE_UNAVAILABLE", "来源助理未参与互查");
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(MAX_REQUEST_MS, (input.deadlineAt ?? performance.now() + MAX_REQUEST_MS) - performance.now())))), signal = AbortSignal.any([timeout, ...(input.signal ? [input.signal] : [])]);
    const scoped = { ...input, signal }, sources = [], unavailableSources = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, owners.length) }, async () => {
      while (next < owners.length) {
        const ownerProfileId = owners[next++];
        try {
          const method = input.candidateMode === "trigger" ? "triggerCandidates" : "search";
          const result = await this.reader[method]({ ...this.sourceInput(scoped, ownerProfileId), query: input.query,
            maxResults: Math.min(input.maxResults ?? input.limit ?? 10, 20), minScore: input.minScore, lexicalOnly: input.lexicalOnly }, input.triggerOptions || {});
          this.sourceInput(scoped, ownerProfileId).assertCurrent();
          const values = result.results.filter(value => !this.suppressed(input.profileId, value));
          sources.push({ ownerProfileId, values, semantic: result.semantic });
        } catch (error) {
          input.signal?.throwIfAborted();
          unavailableSources.push({ ownerProfileId, ...(timeout.aborted ? { code: "MEMORY_SHARED_SOURCE_TIMEOUT" } : unavailable(error)) });
        }
      }
    }));
    input.signal?.throwIfAborted();
    const currentPolicy = this.policy(input);
    // A source can leave while the first query is still pending. With no
    // earlier borrowed dependency, keep the caller's own/healthy results;
    // previously dependent runs remain fenced by policy/assertRunCurrent.
    for (const ownerProfileId of owners) if (!currentPolicy.participatingProfileIds.includes(ownerProfileId)
      && !unavailableSources.some(source => source.ownerProfileId === ownerProfileId)) {
      unavailableSources.push({ ownerProfileId, code: "MEMORY_SHARED_SOURCE_REVOKED" });
    }
    const ranked = [];
    if (!input.ownerProfileId || input.ownerProfileId === input.profileId) for (const [rank, result] of own.results.entries()) ranked.push({ value: result, fused: 1.05 / (60 + rank + 1), owner: input.profileId });
    for (const source of sources.sort((a, b) => a.ownerProfileId.localeCompare(b.ownerProfileId))) for (const [rank, value] of source.values.entries()) {
      ranked.push({ value, fused: 1 / (60 + rank + 1), owner: source.ownerProfileId });
    }
    ranked.sort((a, b) => b.fused - a.fused || a.owner.localeCompare(b.owner));
    const results = []; let bytes = 0, selectionTruncated = false;
    for (const entry of ranked) {
      if (results.length >= Math.min(input.maxResults ?? input.limit ?? 10, 20)) { selectionTruncated = true; break; }
      const size = Buffer.byteLength(entry.value.snippet || "");
      if (bytes + size > (input.maxBytes ?? 24 * 1024)) { selectionTruncated = true; continue; }
      if (entry.owner !== input.profileId) {
        try {
          const current = this.reader.revalidate(this.sourceInput(input, entry.owner), entry.value);
          results.push({ ...this.issue(input, { ...entry.value, ...current }, currentPolicy), score: entry.fused });
        } catch (error) {
          input.signal?.throwIfAborted();
          if (!unavailableSources.some(source => source.ownerProfileId === entry.owner)) {
            unavailableSources.push({ ownerProfileId: entry.owner, ...unavailable(error) });
          }
          continue;
        }
      } else results.push({ ...entry.value, score: entry.fused });
      bytes += size;
    }
    const sourceMetadata = sources.filter(value => currentPolicy.participatingProfileIds.includes(value.ownerProfileId))
      .map(value => ({ ownerProfileId: value.ownerProfileId, semantic: value.semantic }));
    let displayedSources = sourceMetadata, displayedUnavailable = unavailableSources, trimmed = selectionTruncated;
    const payload = () => ({ ...own, items: own.items.filter(item => results.some(result => !result.borrowed
      && item.memoryPath === result.path && item.startLine <= result.endLine && item.endLine >= result.startLine)),
      results, borrowedMemoryRefs: extractBorrowedMemoryRefs({ results }),
      truncated: own.truncated || trimmed, coverage: unavailableSources.length ? "partial" : "complete",
      unavailableSources: displayedUnavailable, sources: displayedSources,
      ...(trimmed ? { sourceCount: sources.length, unavailableSourceCount: unavailableSources.length,
        sourceMetadataTruncated: displayedSources.length !== sourceMetadata.length || displayedUnavailable.length !== unavailableSources.length } : {}) });
    let result = payload();
    // The public MCP envelope includes repeated origin metadata as well as
    // snippets. Bound the complete result before serialization, preserving
    // the highest-ranked own/borrowed matches when source inventories grow.
    const oversized = () => Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES;
    if (oversized() && displayedSources.length) { displayedSources = []; trimmed = true; result = payload(); }
    while (oversized() && displayedUnavailable.length) {
      displayedUnavailable = displayedUnavailable.slice(0, Math.floor(displayedUnavailable.length / 2));
      trimmed = true; result = payload();
    }
    while (oversized() && results.length) {
      const removed = results.pop();
      if (removed.borrowed) { this.access.delete(removed.sourceRef); this.access.delete(removed.path); }
      trimmed = true; result = payload();
    }
    this.registerDependencies(input, result.borrowedMemoryRefs);
    return result;
  }
  get(input) {
    const { reference, current } = this.validateReference(input, input.id || input.path), dep = reference.dependency;
    const from = input.from ?? dep.startLine, lines = input.lines ?? dep.endLine - from + 1;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(lines) || lines < 1 || lines > 200
      || from < dep.startLine || from + lines - 1 > dep.endLine) fail("MEMORY_SHARED_REFERENCE_INVALID", "借阅引用不能扩大读取范围");
    const text = current.snippet.split("\n").slice(from - dep.startLine, from - dep.startLine + lines).join("\n");
    this.registerDependencies(input, [dep]);
    return { path: reference.virtualPath, sourceRef: reference.id, text, from, lines, totalLines: dep.endLine,
      ...dep, borrowed: true, persistPolicy: "reference_only", borrowedMemoryRefs: [dep], items: [],
      revision: this.service.store.getRevision(input.profileId), viewStatus: this.service.viewStatus(input.profileId),
      citation: `${dep.ownerDisplayName} · ${dep.canonicalRelativePath}#L${from}-L${from + lines - 1}` };
  }
  explain(input) {
    const { reference } = this.validateReference(input, input.id), dep = reference.dependency;
    this.registerDependencies(input, [dep]);
    return { ...dep, sourceRef: reference.id, borrowed: true, persistPolicy: "reference_only", borrowedMemoryRefs: [dep], items: [],
      evidence: { status: "verified", kind: dep.documentKind, citation: `${dep.ownerDisplayName} · ${dep.canonicalRelativePath}#L${dep.startLine}-L${dep.endLine}`,
        sourceRevision: dep.sourceRevision }, revision: this.service.store.getRevision(input.profileId) };
  }
  registerDependencies(input, refs) {
    refs = normalizeBorrowedMemoryRefs(refs);
    if (!refs.length) return;
    if (!this.interactive(input)) fail("MEMORY_SHARED_READ_INVALID", "借阅仅用于当前直接对话");
    const state = this.runs.get(input.run.id) || { input: { profileId: input.profileId, workspace: input.workspace,
      maxSensitivity: input.maxSensitivity, run: input.run, sessionId: this.service.chatSessionStore.listSessions().find(session => session.profileId === input.profileId && (session.id === input.run.sourceId || session.sessionKey === input.run.sourceId))?.id }, refs: [], revoked: false };
    state.refs = mergeBorrowedMemoryRefs(state.refs, refs); this.runs.set(input.run.id, state);
    this.onBorrowed?.(input.run.id, state.refs);
    if (!this.timer) { this.timer = setInterval(() => { void this.reconcileConfig().catch(() => {}); }, 250); this.timer.unref(); }
  }
  borrowedRefsForRun(runId) { return structuredClone(this.runs.get(runId)?.refs || []); }
  dependenciesCurrent(profileId, sessionId, refs) {
    try {
      refs = normalizeBorrowedMemoryRefs(refs);
      if (!refs.length) return true;
      const session = this.service.chatSessionStore.listSessions().find(value => value.profileId === profileId && value.id === sessionId);
      const policy = this.config?.resolve(profileId, this.service.profiles());
      if (!session || !policy?.enabled) return false;
      for (const dep of refs) {
        if (dep.requesterProfileId !== profileId || !policy.participatingProfileIds.includes(dep.ownerProfileId)) return false;
        const current = this.reader.revalidate({ ownerProfileId: dep.ownerProfileId, requesterProfileId: profileId,
          workspace: session.workspace, maxSensitivity: "private" }, dep);
        if (this.suppressed(profileId, current)) return false;
      }
      return true;
    } catch { return false; }
  }
  assertRunCurrent(runId) {
    const state = this.runs.get(runId);
    if (!state) return;
    if (state.revoked) fail("MEMORY_SHARED_SOURCE_REVOKED", "借阅来源已撤回，本轮回答已停止");
    for (const dep of state.refs) {
      try {
        const current = this.reader.revalidate(this.sourceInput(state.input, dep.ownerProfileId), dep);
        if (this.suppressed(state.input.profileId, current)) fail("MEMORY_SHARED_SOURCE_REVOKED", "借阅内容已屏蔽");
      } catch (error) {
        // An edit invalidates reuse on the next turn, while explicit withdrawal
        // prevents any subsequent output from this in-flight turn.
        if (error.code === "MEMORY_SOURCE_CHANGED") continue;
        state.revoked = true; throw error;
      }
    }
  }
  withdraw(ownerProfileId, items) {
    for (const state of this.runs.values()) if (state.refs.some(dep => dep.ownerProfileId === ownerProfileId
      && items.some(item => item.memoryPath === dep.canonicalRelativePath && item.startLine <= dep.endLine && item.endLine >= dep.startLine))) state.revoked = true;
  }
  async reconcileConfig() {
    const tasks = [];
    for (const [runId, state] of this.runs) {
      if (state.revocationDelivered) continue;
      try { this.assertRunCurrent(runId); }
      catch {
        state.revoked = true; state.revocationDelivered = true;
        tasks.push(Promise.resolve().then(() => this.onRevoked?.(runId)));
      }
    }
    await Promise.allSettled(tasks);
  }
  validateResult(input, result) {
    for (const item of result?.results || []) if (item.borrowed) this.validateReference(input, item.sourceRef);
    if (result?.borrowed && result.sourceRef) this.validateReference(input, result.sourceRef);
    this.assertRunCurrent(input.run?.id); return result;
  }
  async forget(input, operationId) {
    const { reference, current } = this.validateReference(input, input.id);
    if (this.service.store.getRevision(input.profileId) !== input.expectedRevision) fail("MEMORY_REVISION_CONFLICT", "记忆已经变化，请重新读取");
    const hashes = [current.sourceHash];
    for (const item of this.service.store.list(current.ownerProfileId, { status: "active" })) if (item.memoryPath === current.canonicalRelativePath
      && item.startLine <= current.endLine && item.endLine >= current.startLine) hashes.push(require("../memory-engine").contentHash(item.content));
    const texts = suppressionTexts(current.snippet);
    for (const item of this.service.store.list(current.ownerProfileId, { status: "active" })) if (item.memoryPath === current.canonicalRelativePath
      && item.startLine <= current.endLine && item.endLine >= current.startLine) texts.push(...suppressionTexts(item.content));
    this.service.database.transact(() => {
      for (const text of new Set(texts)) this.service.database.db.prepare("INSERT OR IGNORE INTO memory_borrowed_content_suppressions VALUES (?,?,?,?,?)")
        .run(input.profileId, digest(text), text.length, operationId, this.service.now());
      for (const hash of hashes) this.service.database.db.prepare("INSERT OR IGNORE INTO memory_borrowed_suppressions VALUES (?,?,?,?)")
        .run(input.profileId, hash, operationId, this.service.now());
    });
    // The body-free forget receipt can finish, but the running model already
    // received this source. Keep its dependency and fence every later output.
    // Do not wait for physical interruption inside the MCP call it may stop.
    const state = this.runs.get(input.run.id);
    if (state) state.revoked = true;
    void this.reconcileConfig().catch(() => {});
    return { item: { id: operationId, status: "suppressed" }, suppressed: true, saved: false,
      sourceOwnerProfileId: current.ownerProfileId, borrowedMemoryRefs: [reference.dependency], persistPolicy: "reference_only",
      revision: this.service.store.getRevision(input.profileId), message: "已在当前助理中屏蔽；修改原文请前往来源助理" };
  }
  suppressionCurrent(profileId, operationId) {
    this.service.database.open();
    try { return Boolean(this.service.database.db.prepare("SELECT 1 FROM memory_borrowed_suppressions WHERE profile_id=? AND operation_id=?").get(profileId, operationId)); }
    catch { return false; }
  }
  endRun(run) {
    for (const controller of this.requests.get(run.id) || []) controller.abort(serviceError("MEMORY_SHARED_SOURCE_REVOKED", "本轮已结束，记忆读取已停止"));
    this.requests.delete(run.id);
    this.runs.delete(run.id);
    for (const [key, reference] of this.access) if (reference.runId === run.id) this.access.delete(key);
    if (!this.runs.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  close() {
    for (const controllers of this.requests.values()) for (const controller of controllers) {
      controller.abort(serviceError("MEMORY_SHARED_SOURCE_REVOKED", "服务已停止，记忆读取已停止"));
    }
    this.requests.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.access.clear(); this.runs.clear();
  }
}
module.exports = { SharedReadService };
