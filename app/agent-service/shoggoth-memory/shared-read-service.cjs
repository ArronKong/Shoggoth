"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const { serviceError } = require("../security");
const { OwnerMemoryReader } = require("./owner-memory-reader.cjs");
const { MAX_REFS, normalizeBorrowedMemoryRefs, mergeBorrowedMemoryRefs, extractBorrowedMemoryRefs } = require("./borrowed-memory-provenance.cjs");
const fail = (code, message) => { throw serviceError(code, message); };
const ACCESS_PREFIX = "shared-memory:";
const ACCESS_TTL = 10 * 60_000;
const MAX_ACCESS = 4096;
const MAX_REQUEST_MS = 30_000;
const TRIGGER_INDEX_PREPARATION_MS = 5_000;
const MAX_RESPONSE_BYTES = 48 * 1024;
const REQUEST_SCOPE = Symbol("shared-memory-request");
const DEFER_MONITOR_CODES = new Set(["MEMORY_SCAN_BUSY", "MEMORY_SCAN_UNAVAILABLE", "MEMORY_SCAN_TOO_LARGE",
  "MEMORY_REVISION_CONFLICT", "MEMORY_READ_VIEW_STALE"]);
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
    this.triggerIndexPreparations = new Set();
    this.monitorFlight = null;
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
  suppressionDatabase() {
    this.service.database.open();
    const db = this.service.database.db;
    db.exec("CREATE TABLE IF NOT EXISTS memory_borrowed_suppressions (profile_id TEXT NOT NULL, source_hash TEXT NOT NULL, operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(profile_id,source_hash)) STRICT");
    db.exec("CREATE TABLE IF NOT EXISTS memory_borrowed_content_suppressions (profile_id TEXT NOT NULL, content_hash TEXT NOT NULL, text_length INTEGER NOT NULL, operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(profile_id,content_hash)) STRICT");
    return db;
  }
  suppressed(profileId, evidence) {
    const db = this.suppressionDatabase();
    const hashes = [evidence.sourceHash];
    const items = this.service.activeFileEntries(evidence.ownerProfileId, evidence.canonicalRelativePath)
      .filter(item => item.startLine <= evidence.endLine && item.endLine >= evidence.startLine);
    for (const item of items) hashes.push(require("../memory-content").contentHash(item.content));
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
    return this.service.withMemoryReadView(dep.ownerProfileId, () => {
      const current = this.reader.revalidate(this.sourceInput(input, dep.ownerProfileId), dep);
      if (this.suppressed(input.profileId, current)) fail("MEMORY_SHARED_SOURCE_REVOKED", "此内容已在当前助理中屏蔽");
      return { reference, current };
    });
  }
  withReferenceReadViews(input, id, read) {
    const owner = this.reference(input, id).dependency.ownerProfileId;
    const owners = new Set([owner, ...this.ownersForRun(input.run.id)]);
    return this.withDependencyReadViews(input.profileId, owners, input.signal, view => {
      this.reference(input, id);
      if (this.ownersForRun(input.run.id).some(profileId => !owners.has(profileId))) {
        fail("MEMORY_REVISION_CONFLICT", "借阅来源在读取前已变化");
      }
      return read(view);
    }, { requireOwners: true });
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
      if (this.runs.has(runId)) await this.withRunReadProof(runId, scoped.signal, () => {}, { markRevoked: true });
      scoped.signal.throwIfAborted();
      const result = await action(scoped);
      scoped.signal.throwIfAborted();
      return result;
    } finally {
      pending.delete(controller);
      if (!pending.size && this.requests.get(runId) === pending) this.requests.delete(runId);
    }
  }
  prepareTriggerOwners(input) {
    return this.withRequest(input, async scoped => {
      const policy = this.policy(scoped);
      if (!policy.enabled) return;
      // Cold lender indices may need a rebuild before deterministic recall.
      // Use the parent preparation deadline and bound work across all turns.
      const signal = AbortSignal.any([scoped.signal, AbortSignal.timeout(TRIGGER_INDEX_PREPARATION_MS)]);
      const owners = policy.participatingProfileIds
        .filter(id => id !== scoped.profileId && !this.triggerIndexPreparations.has(id))
        .slice(0, Math.max(0, 3 - this.triggerIndexPreparations.size));
      await Promise.all(owners.map(async ownerProfileId => {
        const source = this.sourceInput({ ...scoped, signal }, ownerProfileId);
        this.triggerIndexPreparations.add(ownerProfileId);
        let preparation;
        try {
          preparation = this.reader.prepareTriggers(source);
          await preparation?.ready;
        } catch {
          // Optional preparation cannot withdraw another owner's eligible
          // results. The actual query still checks its source and deadline.
        } finally {
          const release = () => this.triggerIndexPreparations.delete(ownerProfileId);
          // Caller cancellation returns early. Keep its capacity occupied
          // until the exact owner index task has physically settled.
          if (preparation) void preparation.settled.then(release, release);
          else release();
        }
      }));
    });
  }
  search(input, own, { withPublicationView, publish = result => result } = {}) {
    return this.withRequest(input, scoped => this.searchSources(scoped, own, withPublicationView, publish));
  }
  async searchSources(input, own, withPublicationView, publish) {
    const policy = this.policy(input);
    const publishOwn = () => publish(own);
    if (!policy.enabled || input.memoryScope === "own"
      || Array.isArray(input.sources) && !input.sources.includes("memory")) {
      return withPublicationView ? withPublicationView(publishOwn) : publishOwn();
    }
    if (!["normal", "private"].includes(input.maxSensitivity)) fail("MEMORY_SHARED_READ_INVALID", "借阅敏感度范围无效");
    const owners = policy.participatingProfileIds.filter(id => id !== input.profileId && (!input.ownerProfileId || id === input.ownerProfileId));
    if (input.ownerProfileId && !policy.participatingProfileIds.includes(input.ownerProfileId)) fail("MEMORY_SHARED_SOURCE_UNAVAILABLE", "来源助理未参与互查");
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(MAX_REQUEST_MS, (input.deadlineAt ?? performance.now() + MAX_REQUEST_MS) - performance.now())))), signal = AbortSignal.any([timeout, ...(input.signal ? [input.signal] : [])]);
    const scoped = { ...input, signal }, sources = [], unavailableSources = [], proofs = new Map();
    const unavailableOwner = (ownerProfileId, error) => {
      if (!unavailableSources.some(source => source.ownerProfileId === ownerProfileId)) {
        unavailableSources.push({ ownerProfileId, ...unavailable(error) });
      }
    };
    const finish = () => {
      const produce = () => this.publishSearch(input, own, { owners, sources, unavailableSources, proofs, unavailableOwner }, publish);
      return withPublicationView ? withPublicationView(produce) : produce();
    };
    // A fresh DB can acquire these tables on its first search. Do that
    // before collecting any snapshot whose DB stamp must stay stable.
    if (owners.length) {
      try { this.suppressionDatabase(); }
      catch (error) {
        input.signal?.throwIfAborted();
        for (const owner of owners) unavailableOwner(owner, error);
        return finish();
      }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, owners.length) }, async () => {
      while (next < owners.length) {
        const ownerProfileId = owners[next++];
        try {
          const method = input.candidateMode === "trigger" ? "triggerCandidates" : "search";
          const result = await this.reader[method]({ ...this.sourceInput(scoped, ownerProfileId), query: input.query,
            maxResults: Math.min(input.maxResults ?? input.limit ?? 10, 20), minScore: input.minScore, lexicalOnly: input.lexicalOnly }, input.triggerOptions || {});
          this.sourceInput(scoped, ownerProfileId).assertCurrent();
          if (!result.results.length) {
            sources.push({ ownerProfileId, values: [], semantic: result.semantic });
            continue;
          }
          const source = { ownerProfileId, values: result.results, semantic: result.semantic };
          sources.push(source);
          // Bound the final scan with the source budget. Retaining uses the
          // request lifetime so a timed-out sibling cannot invalidate an owner
          // whose scan was already completed.
          const proof = await this.service.withAsyncMemoryReadView(ownerProfileId, input.signal, view => {
            signal.throwIfAborted();
            this.sourceInput(scoped, ownerProfileId).assertCurrent();
            return view.retainProof();
          }, signal);
          proofs.set(ownerProfileId, proof);
        } catch (error) {
          input.signal?.throwIfAborted();
          unavailableSources.push({ ownerProfileId, ...(timeout.aborted ? { code: "MEMORY_SHARED_SOURCE_TIMEOUT" } : unavailable(error)) });
        }
      }
    }));
    return finish();
  }
  publishSearch(input, own, { owners, sources, unavailableSources, proofs, unavailableOwner }, publish) {
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
    const acceptedProofs = new Map();
    if (!input.ownerProfileId || input.ownerProfileId === input.profileId) for (const [rank, result] of own.results.entries()) ranked.push({ value: result, fused: 1.05 / (60 + rank + 1), owner: input.profileId });
    for (const source of sources.sort((a, b) => a.ownerProfileId.localeCompare(b.ownerProfileId))) {
      const owner = source.ownerProfileId, proof = proofs.get(owner);
      if (!proof || !currentPolicy.participatingProfileIds.includes(owner)) continue;
      const sourceInput = this.sourceInput(input, owner);
      const current = [];
      try {
        proof.read(view => this.service.withSuppliedReadView(owner, view, () => {
          let rank = 0;
          for (const value of source.values) {
            // Preserve the old rank among unsuppressed hits, including a hit
            // whose subsequent content/origin verification fails.
            if (this.suppressed(input.profileId, value)) continue;
            const fused = 1 / (60 + ++rank);
            if (Buffer.byteLength(value.snippet || "") > (input.maxBytes ?? 24 * 1024)) {
              current.push({ value, fused, owner });
              continue;
            }
            try {
              const match = this.reader.revalidate(sourceInput, value);
              if (this.suppressed(input.profileId, match)) fail("MEMORY_SHARED_SOURCE_REVOKED", "此内容已在当前助理中屏蔽");
              current.push({ value: { ...value, ...match }, fused, owner });
            } catch (error) { unavailableOwner(owner, error); }
          }
          view.assertFilesCurrent();
        }));
        ranked.push(...current);
        acceptedProofs.set(owner, proof);
      } catch (error) { unavailableOwner(owner, error); }
    }
    input.signal?.throwIfAborted();
    ranked.sort((a, b) => b.fused - a.fused || a.owner.localeCompare(b.owner));
    const results = []; let bytes = 0, selectionTruncated = false;
    for (const entry of ranked) {
      if (results.length >= Math.min(input.maxResults ?? input.limit ?? 10, 20)) { selectionTruncated = true; break; }
      const size = Buffer.byteLength(entry.value.snippet || "");
      if (bytes + size > (input.maxBytes ?? 24 * 1024)) { selectionTruncated = true; continue; }
      if (entry.owner !== input.profileId) {
        try {
          results.push({ ...this.issue(input, entry.value, currentPolicy), score: entry.fused });
        } catch (error) {
          input.signal?.throwIfAborted();
          unavailableOwner(entry.owner, error);
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
    try {
      const published = publish(result);
      // Dependency anchoring can read legacy refs from other owners. Reuse
      // the validated worker projection for owners selected by this search.
      const selected = [...new Set(result.borrowedMemoryRefs.map(ref => ref.ownerProfileId))];
      const register = index => {
        if (index === selected.length) return this.registerDependencies(input, result.borrowedMemoryRefs);
        const owner = selected[index];
        return acceptedProofs.get(owner).read(view => this.service.withSuppliedReadView(owner, view, () => register(index + 1)));
      };
      register(0);
      return published;
    } catch (error) {
      // A failed requester proof cannot leave unpublished access capabilities.
      for (const entry of results) if (entry.borrowed) {
        this.access.delete(entry.sourceRef); this.access.delete(entry.path);
      }
      throw error;
    }
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
    const merged = mergeBorrowedMemoryRefs(state.refs, refs);
    this.onBorrowed?.(input.run.id, merged);
    state.refs = merged;
    this.runs.set(input.run.id, state);
    if (!this.timer) {
      this.monitorController = new AbortController();
      this.timer = setInterval(() => { void this.monitorSources().catch(() => {}); }, 250);
      this.timer.unref();
    }
  }
  borrowedRefsForRun(runId) { return structuredClone(this.runs.get(runId)?.refs || []); }
  hasRunDependencies(runId) { return this.runs.has(runId); }
  ownersForRun(runId) {
    return [...new Set((this.runs.get(runId)?.refs || []).map(ref => ref.ownerProfileId))];
  }
  ownersForResult(input, result) {
    const owners = new Set(this.ownersForRun(input.run?.id));
    const add = item => owners.add(this.reference(input, item.sourceRef).dependency.ownerProfileId);
    for (const item of result?.results || []) if (item.borrowed) add(item);
    if (result?.borrowed && result.sourceRef) add(result);
    return [...owners];
  }
  async withDependencyReadViews(profileId, ownerIds, signal, read, { requireOwners = false } = {}) {
    signal?.throwIfAborted();
    const candidates = new Set(ownerIds);
    if (candidates.size > MAX_REFS) fail("BORROWED_MEMORY_PROVENANCE_LIMIT", "借阅来源超过会话容量，需要新建会话");
    const proofs = [];
    if (candidates.size) {
      let participants;
      try {
        const policy = this.config?.resolve(profileId, this.service.profiles());
        if (policy?.enabled) participants = policy.participatingProfileIds;
      }
      catch { /* A missing policy grants no source access. */ }
      if (requireOwners && [...candidates].some(owner => !participants?.includes(owner))) {
        fail("MEMORY_SHARED_SOURCE_REVOKED", "借阅权限已撤回");
      }
      const scanSignal = AbortSignal.timeout(MAX_REQUEST_MS);
      for (const owner of participants || []) {
        if (owner === profileId || !candidates.has(owner)) continue;
        if (scanSignal.aborted) {
          if (requireOwners) fail("MEMORY_SHARED_SOURCE_TIMEOUT", "借阅来源核验超时");
          break;
        }
        try {
          const proof = await this.service.withAsyncMemoryReadView(owner, signal, view => view.retainProof(), scanSignal);
          proofs.push({ owner, proof });
        } catch (error) {
          signal?.throwIfAborted();
          if (requireOwners) throw error;
        }
      }
    }
    return this.service.withAsyncMemoryReadView(profileId, signal, ownView => {
      const current = requireOwners ? proofs : proofs.filter(item => item.proof.current());
      return this.readDependencyProofs(profileId, ownView, current, read);
    });
  }
  readDependencyProofs(profileId, ownView, proofs, read) {
    const assertFilesCurrent = () => {
      ownView.assertFilesCurrent();
      for (const { owner } of proofs) this.service.memoryViewFor(owner).assertFilesCurrent();
    };
    const retainProof = () => {
      const ownProof = ownView.retainProof();
      return { read: next => ownProof.read(view => this.service.withSuppliedReadView(profileId, view,
        () => this.readDependencyProofs(profileId, view, proofs, next))) };
    };
    const enter = index => {
      if (index < proofs.length) {
        const { owner, proof } = proofs[index];
        return proof.read(view => this.service.withSuppliedReadView(owner, view, () => enter(index + 1)));
      }
      return this.withDependencyReadScope(profileId, new Set(proofs.map(item => item.owner)), () => {
        assertFilesCurrent();
        return read({ assertFilesCurrent, retainProof });
      });
    };
    return enter(0);
  }
  withDependencyReadScope(profileId, owners, read) {
    const previous = this.dependencyReadScope;
    this.dependencyReadScope = { profileId, owners, previous };
    try { return read(); }
    finally { this.dependencyReadScope = previous; }
  }
  dependenciesCurrent(profileId, sessionId, refs) {
    try {
      refs = normalizeBorrowedMemoryRefs(refs);
      if (!refs.length) return true;
      const store = this.service.chatSessionStore;
      const session = store.findSessionById ? store.findSessionById(sessionId)
        : store.listSessions().find(value => value.profileId === profileId && value.id === sessionId);
      const policy = this.config?.resolve(profileId, this.service.profiles());
      if (session?.profileId !== profileId || !policy?.enabled) return false;
      let scope = this.dependencyReadScope;
      while (scope && scope.profileId !== profileId) scope = scope.previous;
      for (const dep of refs) {
        if (dep.requesterProfileId !== profileId || !policy.participatingProfileIds.includes(dep.ownerProfileId)
          || (scope && !scope.owners.has(dep.ownerProfileId))) return false;
        const current = this.service.withMemoryReadView(dep.ownerProfileId, () => {
          const evidence = this.reader.revalidate({ ownerProfileId: dep.ownerProfileId, requesterProfileId: profileId,
            workspace: session.workspace, maxSensitivity: "private" }, dep);
          return !this.suppressed(profileId, evidence);
        });
        if (!current) return false;
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
        this.service.withMemoryReadView(dep.ownerProfileId, () => this.assertDependencyCurrent(state, dep));
      } catch (error) {
        // An edit invalidates reuse on the next turn, while explicit withdrawal
        // prevents any subsequent output from this in-flight turn.
        if (error.code === "MEMORY_SOURCE_CHANGED") continue;
        state.revoked = true; throw error;
      }
    }
  }
  assertDependencyCurrent(state, dep) {
    const current = this.reader.revalidate(this.sourceInput(state.input, dep.ownerProfileId), dep);
    if (this.suppressed(state.input.profileId, current)) fail("MEMORY_SHARED_SOURCE_REVOKED", "借阅内容已屏蔽");
  }
  async withRunReadProof(runId, signal, publish, { markRevoked = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const state = this.runs.get(runId);
      if (!state) return;
      if (state.revoked) fail("MEMORY_SHARED_SOURCE_REVOKED", "借阅来源已撤回，本轮回答已停止");
      const refs = state.refs, byOwner = new Map();
      for (const dep of refs) {
        if (!byOwner.has(dep.ownerProfileId)) byOwner.set(dep.ownerProfileId, []);
        byOwner.get(dep.ownerProfileId).push(dep);
      }
      try {
        const owners = [];
        for (const [owner, deps] of byOwner) {
          const proof = await this.service.withAsyncMemoryReadView(owner, signal, view => view.retainProof());
          owners.push({ owner, deps, proof });
        }
        const assertCurrent = () => {
          signal?.throwIfAborted();
          if (this.runs.get(runId) !== state || state.revoked) {
            fail("MEMORY_SHARED_SOURCE_REVOKED", "借阅来源已撤回，本轮回答已停止");
          }
          if (state.refs !== refs) fail("MEMORY_REVISION_CONFLICT", "本轮借阅来源发生变化");
        };
        const check = index => {
          assertCurrent();
          if (index === owners.length) {
            for (const { owner } of owners) this.service.memoryViewFor(owner).assertFilesCurrent();
            return;
          }
          const { owner, deps, proof } = owners[index];
          return proof.read(view => this.service.withSuppliedReadView(owner, view, () => {
            for (const dep of deps) {
              try { this.assertDependencyCurrent(state, dep); }
              catch (error) {
                if (error.code === "MEMORY_SOURCE_CHANGED") continue;
                if (markRevoked && !DEFER_MONITOR_CODES.has(error.code)) state.revoked = true;
                throw error;
              }
            }
            return check(index + 1);
          }));
        };
        check(0);
      } catch (error) {
        if (signal?.aborted || !DEFER_MONITOR_CODES.has(error?.code)) throw error;
        if (attempt >= 2) throw serviceError("CONTEXT_MEMORY_READ_UNAVAILABLE", "无法核验输出所需的借阅来源", { cause: error });
        await wait(20, undefined, { signal });
        continue;
      }
      // Leave the temporary owner views before committing Product output.
      // No await separates proof verification and the publication callback.
      return publish();
    }
  }
  async monitorSources() {
    const signal = this.monitorController?.signal;
    if (this.monitorFlight || !signal || signal.aborted) return this.monitorFlight;
    const check = async () => {
      const byOwner = new Map();
      const notifications = [];
      for (const [runId, state] of this.runs) {
        if (state.revoked) { notifications.push(this.deliverRevocation(runId, state)); continue; }
        for (const dep of state.refs) {
          if (!byOwner.has(dep.ownerProfileId)) byOwner.set(dep.ownerProfileId, []);
          byOwner.get(dep.ownerProfileId).push({ runId, state, dep });
        }
      }
      for (const [owner, entries] of byOwner) {
        if (signal.aborted) break;
        let revoked;
        try {
          revoked = await this.service.withAsyncMemoryReadView(owner, signal, view => {
            const withdrawals = [];
            for (const { runId, state, dep } of entries) {
              if (this.runs.get(runId) !== state || state.revoked) continue;
              // registerDependencies only merges; these captured proofs still
              // belong to this run while its exact state remains current.
              try { this.assertDependencyCurrent(state, dep); }
              catch (error) {
                if (error.code !== "MEMORY_SOURCE_CHANGED" && !DEFER_MONITOR_CODES.has(error.code)) {
                  withdrawals.push({ runId, state });
                }
              }
            }
            view.assertFilesCurrent();
            return withdrawals;
          });
        } catch (error) {
          // A busy or uncertain scan has proven neither a withdrawal nor
          // permission to publish. The immediate output fence still checks it.
          if (signal.aborted || DEFER_MONITOR_CODES.has(error.code)) continue;
          revoked = entries;
        }
        if (signal.aborted) break;
        for (const { runId, state } of revoked) notifications.push(this.deliverRevocation(runId, state));
      }
      await Promise.allSettled(notifications);
    };
    this.monitorFlight = check().finally(() => { this.monitorFlight = null; });
    return this.monitorFlight;
  }
  withdraw(ownerProfileId, items) {
    for (const state of this.runs.values()) if (state.refs.some(dep => dep.ownerProfileId === ownerProfileId
      && items.some(item => item.memoryPath === dep.canonicalRelativePath && item.startLine <= dep.endLine && item.endLine >= dep.startLine))) state.revoked = true;
  }
  async reconcileConfig() {
    const tasks = [];
    const signal = this.monitorController?.signal;
    const stopped = profileId => this.service.profileControllers?.get(profileId)?.signal.aborted;
    let hasLiveSources = false;
    for (const [runId, state] of this.runs) {
      if (!state.revoked) {
        try {
          const policy = this.policy(state.input);
          if (!policy.enabled || stopped(state.input.profileId) || state.refs.some(dep =>
            stopped(dep.ownerProfileId) || !policy.participatingProfileIds.includes(dep.ownerProfileId))) {
            state.revoked = true;
          }
        } catch { state.revoked = true; }
      }
      if (state.revoked) {
        tasks.push(this.deliverRevocation(runId, state));
      } else hasLiveSources = true;
    }
    if (hasLiveSources) {
      // An earlier monitor may already have checked the edited owner. Ask
      // for a fresh pass after it settles, in the same monitor generation.
      const refresh = () => {
        if (signal && !signal.aborted && this.monitorController?.signal === signal) return this.monitorSources();
      };
      const previous = this.monitorFlight;
      tasks.push(previous ? previous.then(refresh, refresh) : refresh());
    }
    await Promise.allSettled(tasks);
  }
  deliverRevocation(runId, state) {
    if (this.runs.get(runId) !== state) return;
    if (state.revocationDelivered) return state.revocationPending;
    state.revoked = true; state.revocationDelivered = true;
    const pending = Promise.resolve().then(() => {
      if (this.runs.get(runId) === state) return this.onRevoked?.(runId);
    }).finally(() => { state.revocationPending = null; });
    state.revocationPending = pending;
    pending.catch(() => {});
    return pending;
  }
  validateResult(input, result) {
    for (const item of result?.results || []) if (item.borrowed) this.validateReference(input, item.sourceRef);
    if (result?.borrowed && result.sourceRef) this.validateReference(input, result.sourceRef);
    this.assertRunCurrent(input.run?.id); return result;
  }
  async forget(input, operationId) {
    input.signal?.throwIfAborted(); input.assertCurrent?.();
    const owner = this.reference(input, input.id).dependency.ownerProfileId;
    const proof = await this.withDependencyReadViews(input.profileId, [owner], input.signal,
      view => view.retainProof(), { requireOwners: true });
    const { reference, revision, hashes, contentHashes } = proof.read(view => {
      input.signal?.throwIfAborted(); input.assertCurrent?.();
      const { reference, current } = this.validateReference(input, input.id);
      const revision = this.service.store.getRevision(input.profileId);
      if (revision !== input.expectedRevision) fail("MEMORY_REVISION_CONFLICT", "记忆已经变化，请重新读取");
      const hashes = new Set([current.sourceHash]), texts = new Set(suppressionTexts(current.snippet));
      for (const item of this.service.activeFileEntries(owner, current.canonicalRelativePath)) {
        if (item.startLine > current.endLine || item.endLine < current.startLine) continue;
        hashes.add(require("../memory-content").contentHash(item.content));
        for (const text of suppressionTexts(item.content)) texts.add(text);
      }
      const contentHashes = [...texts].map(text => [digest(text), text.length]);
      view.assertFilesCurrent();
      return { reference, revision, hashes, contentHashes };
    });
    // The transaction advances the DB stamp of both read views. Commit on the
    // same stack after their final validation and synchronous teardown.
    this.service.database.transact(() => {
      for (const [hash, length] of contentHashes) this.service.database.db.prepare("INSERT OR IGNORE INTO memory_borrowed_content_suppressions VALUES (?,?,?,?,?)")
        .run(input.profileId, hash, length, operationId, this.service.now());
      for (const hash of hashes) this.service.database.db.prepare("INSERT OR IGNORE INTO memory_borrowed_suppressions VALUES (?,?,?,?)")
        .run(input.profileId, hash, operationId, this.service.now());
    });
    // The body-free forget receipt can finish, but the running model already
    // received this source. Keep its dependency and fence every later output.
    // Do not wait for physical interruption inside the MCP call it may stop.
    for (const [runId, state] of this.runs) {
      if (state.input.profileId === input.profileId && (runId === input.run.id || state.refs.some(dep => hashes.has(dep.sourceHash)))) {
        this.deliverRevocation(runId, state);
      }
    }
    // Normalized matches in other runs are checked by the asynchronous owner
    // monitor and independently at every output boundary.
    void this.monitorSources().catch(() => {});
    return { item: { id: operationId, status: "suppressed" }, suppressed: true, saved: false,
      sourceOwnerProfileId: owner, borrowedMemoryRefs: [reference.dependency], persistPolicy: "reference_only",
      revision, message: "已在当前助理中屏蔽；修改原文请前往来源助理" };
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
    if (!this.runs.size && this.timer) { clearInterval(this.timer); this.timer = null; this.monitorController?.abort(); }
  }
  close() {
    this.monitorController?.abort();
    for (const controllers of this.requests.values()) for (const controller of controllers) {
      controller.abort(serviceError("MEMORY_SHARED_SOURCE_REVOKED", "服务已停止，记忆读取已停止"));
    }
    this.requests.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.access.clear(); this.runs.clear();
    return this.monitorFlight;
  }
}
module.exports = { SharedReadService };
