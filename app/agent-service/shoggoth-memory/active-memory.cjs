"use strict";

const crypto = require("node:crypto");
const { core } = require("./host.cjs");
const { ActiveMemoryRuntime } = require("./active-memory-runtime.cjs");
const { workspaceMemoryRefs } = require("../memory-workspace");
const { hasSecret } = require("../memory-content");
const { sha256 } = require("./migration.cjs");
const { serviceError } = require("../security");
const { TurnMemo } = require("../turn-memo");
const { ActiveMemoryStatus } = require("./active-memory-status.cjs");
const { captureEvidence, evidenceCurrent } = require("./active-memory-evidence.cjs");
const { recallDiagnostics, diagnosticCode } = require("./active-memory-diagnostics.cjs");
const { hasLocalizedRecallIntent } = require("./cjk-recall-intent.cjs");
const { presentTriggerCandidates } = require("./trigger-presentation.cjs");
const { isShortTerm } = require("./recall-signals.cjs");

// One turn's raw Runtime configuration with deep recall forced. The global
// configuration and every other setting stay as they are.
function withAlwaysMode(base) {
  const entry = base.plugins?.entries?.["active-memory"] || {};
  return { ...base, plugins: { ...base.plugins, entries: { ...base.plugins?.entries,
    "active-memory": { ...entry, config: { ...entry.config, mode: "always" } } } } };
}
const { extractBorrowedMemoryRefs, mergeBorrowedMemoryRefs, isBorrowedMemoryDerived, borrowedMemoryPlaceholder } = require("./borrowed-memory-provenance.cjs");

// Upstream policies and recall-session lifecycle, with Product-owned source
// authority and model transport. The scratch session has no general tools.
class ActiveMemory {
  constructor(service) {
    this.service = service; this.prepared = new Map(); this.pending = new Map();
    this.cacheProofs = new Map(); this.runs = new Map(); this.runtimes = new Set(); this.instance = crypto.randomUUID();
    this.status = new ActiveMemoryStatus(this);
  }
  key(input) { return JSON.stringify([input.profile.id, input.run.id, input.run.workspace, input.query, sha256(this.authority(input.profile.id))]); }
  sharingPolicy(profileId) { return this.service.sharing?.config?.resolve(profileId, this.service.profiles()) || null; }
  // Content version: any memory or source change. Only the cross-turn result
  // cache uses it, so a later turn never reuses a recall made before a change.
  cacheStamp(profileId) { return JSON.stringify([this.service.semanticStamp(profileId), this.service.sourcePolicyStamp(profileId), this.sharingPolicy(profileId)]); }
  // Authority version: only changes that can withdraw returned content. A
  // running recall and its prepare→take hand-off within one turn survive
  // ordinary appends; cited evidence is still rechecked before use.
  authority(profileId) { return JSON.stringify([this.service.authorityStamp(profileId), this.sharingPolicy(profileId)]); }
  sessionId(input) { return input.session?.id || this.service.chatSessionStore.getSession(input.run.sourceId)?.id; }
  runEntry(input) {
    const key = JSON.stringify([input.profile.id, input.run.id]);
    if (!this.runs.has(key)) {
      if (this.runs.size >= core.ACTIVE_MEMORY_MAX_CACHE_ENTRIES) throw serviceError("MEMORY_ACTIVE_CAPACITY", "自动召回执行数量超过预算");
      this.runs.set(key, { key, profileId: input.profile.id, runId: input.run.id,
        sessionKey: input.run.sourceId || input.session?.sessionKey,
        nativeId: `shoggoth:${this.instance}:${sha256(key)}`, controller: new AbortController(), proofs: new Map(), statusPhase: "preparing" });
    }
    return this.runs.get(key);
  }
  async endRun(run) {
    const entry = this.runs.get(JSON.stringify([run.profileId, run.id]));
    if (!entry) return;
    if (entry.cleanup) return entry.cleanup;
    entry.controller.abort();
    for (const [key] of this.prepared) { const [profileId, runId] = JSON.parse(key); if (profileId === run.profileId && runId === run.id) this.prepared.delete(key); }
    const pending = [...this.pending].filter(([key]) => { const [profileId, runId] = JSON.parse(key); return profileId === run.profileId && runId === run.id; }).map(([, work]) => work);
    const runtimes = [...this.runtimes].filter(runtime => runtime.host.profileId === run.profileId && runtime.input.run.id === run.id);
    entry.cleanup = Promise.allSettled([...pending, ...runtimes.map(runtime => runtime.settled)]).then(() => {
      entry.agentEnd?.({ runId: entry.nativeId }, { runId: entry.nativeId });
      if (this.runs.get(entry.key) === entry) this.runs.delete(entry.key);
    });
    return entry.cleanup;
  }
  async reconcileConfig() {
    const obsolete = [...this.runs.values()].filter(entry =>
      entry.policy !== JSON.stringify([this.service.config(entry.profileId), this.sharingPolicy(entry.profileId)]));
    await Promise.all(obsolete.map(entry => this.endRun({ profileId: entry.profileId, id: entry.runId })));
    // Proofs are rebuildable; retiring them cannot withdraw persisted memory.
    if (obsolete.length) this.cacheProofs.clear();
  }
  async stopProfile(profileId) {
    await Promise.allSettled([...this.runs.values()].filter(entry => entry.profileId === profileId)
      .map(entry => this.endRun({ profileId, id: entry.runId })));
  }
  async invalidateSession(profileId, sessionKey) {
    await Promise.allSettled([...this.runs.values()].filter(entry => entry.profileId === profileId && entry.sessionKey === sessionKey)
      .map(entry => this.endRun({ profileId, id: entry.runId })));
  }
  conversationContext(input, host) {
    const key = input.run.sourceId || input.session?.sessionKey;
    if (!key) throw serviceError("MEMORY_ACTIVE_SESSION_INVALID", "自动召回需要当前 Product 对话");
    const session = this.service.chatSessionStore.getSession(key);
    if (!session || session.profileId !== input.profile.id || session.workspace !== (input.run.workspace ?? null)
      || input.session && (input.session.id !== session.id || input.session.sessionKey !== session.sessionKey)
      || this.service.chatSessionStore.getCronSessionOrigin?.(session.sessionKey)) {
      throw serviceError("MEMORY_ACTIVE_SESSION_INVALID", "自动召回的父会话不属于当前用户对话");
    }
    // Draft sessions have no completed history yet. Forgotten sessions remain
    // valid parent identities but cannot supply recalled conversation text.
    if (!host.sessions.list(input.profile.id).some(row => row.id === session.id)) return { session, messages: [], recentTurns: [] };
    const transcript = host.sessions.read(input.profile.id, session.id);
    const messages = transcript.content.split("\n").flatMap(line => {
      const match = /^(User|Assistant): (.*)$/u.exec(line);
      return match && !hasSecret(match[2]) ? [{ role: match[1] === "User" ? "user" : "assistant", content: match[2] }] : [];
    });
    return { session, messages, recentTurns: core.extractActiveMemoryRecentTurns(messages) };
  }
  queryProvenance(input, session) {
    const events = require("../transcript-read").readEvents(this.service.transcriptStore, input.profile.id, session.id);
    const user = events.findLast(event => event.kind === "user" && event.runId === input.run.id);
    const event = user?.content?.contextRef
      ? this.service.transcriptStore.contextEvent(input.profile.id, session.id, user) : user;
    this.service.transcriptStore.assertJournalCurrent?.(input.profile.id, session.id);
    const derived = isBorrowedMemoryDerived(event), refs = derived ? extractBorrowedMemoryRefs(event) : [];
    return { derived, refs, query: derived && !refs.length ? borrowedMemoryPlaceholder([], "invalid") : input.query };
  }
  configuration(profileId) {
    const cfg = this.service.config(profileId), entry = cfg.plugins?.entries?.["active-memory"];
    if (entry?.enabled !== true) return null;
    const config = core.normalizeActiveMemoryConfig(entry.config, cfg, ["memory_search", "memory_get"]);
    return config;
  }
  prepare(input) {
    const key = this.key(input);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.prepared.has(key)) {
      if (this.valid(input, this.prepared.get(key))) return Promise.resolve();
      this.prepared.delete(key);
    }
    const work = this.run(input).then(result => {
      if (result) this.prepared.set(key, result);
      while (this.prepared.size > 32) this.prepared.delete(this.prepared.keys().next().value);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }
  take(input) {
    const key = this.key(input), result = this.prepared.get(key); this.prepared.delete(key);
    return this.valid(input, result) ? result : null;
  }
  bindDelivery(input, snapshotId, content, result) {
    const entry = this.runs.get(JSON.stringify([input.profile.id, input.run.id]));
    if (entry) entry.delivery = { input, snapshotId, content, result };
  }
  stageDelivery(run, snapshotId, context) {
    const delivery = this.runs.get(JSON.stringify([run.profileId, run.id]))?.delivery;
    if (!delivery || delivery.snapshotId !== snapshotId || !context?.includes(delivery.content)
      || !this.valid(delivery.input, delivery.result)) return;
    this.service.recallSignals.stage({ profileId: run.profileId, run, workspace: run.workspace,
      sessionId: this.sessionId(delivery.input), maxSensitivity: "private" }, delivery.result.fastRecalls);
  }
  valid(input, result) {
    if (!result || result.expiresAt <= this.service.now()
      || result.parentSignal?.aborted
      || this.service.profileSignal(input.profile.id).aborted
      || result.stamp !== this.authority(input.profile.id)
      || result.config !== JSON.stringify(this.configuration(input.profile.id))
      || !this.evidenceCurrent(input.profile.id, result.evidence, result.borrowedMemoryRefs, this.sessionId(input))) return false;
    try { result.assertParentCurrent?.(); } catch { return false; }
    return true;
  }
  // Escalate mode skipped deep recall although the user's own Chinese words
  // ask about the past. The upstream decision runs first and checks a strong
  // direct hit before intent, so this outcome already means no strong hit,
  // recall enabled and the destination allowed.
  wantsLocalizedRecall(config, result, query) {
    return config.mode === "escalate" && typeof result?.prependContext === "string"
      && result.prependContext.includes(core.buildRecallOutcomePrefix("skipped-no-recall-intent"))
      && hasLocalizedRecallIntent(query);
  }
  borrowedContext(content, refs) {
    if (!content || !refs.length) return content;
    const labels = refs.map(ref => `${(ref.ownerDisplayName || ref.ownerProfileId).replace(/\s+/gu, " ")} · ${ref.canonicalRelativePath}#L${ref.startLine}-L${ref.endLine}${ref.documentKind === "reflection_report" ? "（反思报告，需结合原始来源）" : ""}`);
    const sources = [...new Set(labels)].join("；").slice(0, 1600).toWellFormed();
    return `${content}\n借阅来源：${sources}\n`;
  }
  evidenceCurrent(profileId, evidence = [], borrowedMemoryRefs = [], sessionId) {
    try {
      const index = this.service.host(profileId).searchIndex;
      return evidence.every(item => evidenceCurrent(index, item))
        && (!borrowedMemoryRefs.length || this.service.borrowedMemoryDependenciesCurrent?.(profileId, sessionId, borrowedMemoryRefs) === true);
    } catch { return false; }
  }
  async close() {
    await Promise.allSettled([...this.runs.values()].map(entry => this.endRun({ profileId: entry.profileId, id: entry.runId })));
    await Promise.allSettled([...this.pending.values(), ...[...this.runtimes].map(runtime => runtime.settled)]);
    this.prepared.clear(); this.cacheProofs.clear();
  }
  async run(input) {
    const service = this.service, profileId = input.profile.id, config = this.configuration(profileId);
    if (!config || input.run.profileId !== profileId || input.run.source !== "chat" || !input.query?.trim()
      || /^shoggoth:chat-send:(?:federation-(?:send|message)|group-(?:turn|task))-/u.test(input.run.idempotencyKey || "")) return null;
    const host = service.host(profileId), stamp = this.authority(profileId), cacheStamp = this.cacheStamp(profileId);
    const serialized = JSON.stringify(config), runEntry = this.runEntry(input);
    runEntry.statusPhase = "preparing";
    runEntry.policy = JSON.stringify([service.config(profileId), this.sharingPolicy(profileId)]);
    const diagnose = recallDiagnostics({ host, runId: input.run.id, now: () => service.now() });
    let stage = "preflight";
    const evidence = new Map();
    const fastCandidates = new WeakMap();
    const historyHits = new Map();
    let borrowedMemoryRefs = [], borrowedMemoryDerived = false;
    const signal = AbortSignal.any([service.maintenance.controller.signal, service.profileSignal(profileId), runEntry.controller.signal,
      ...(input.signal ? [input.signal] : [])]);
    const preflightDeadline = AbortSignal.timeout(config.timeoutMs + config.setupGraceTimeoutMs);
    let phase = "preflight", modelContext, sessionPolicy;
    // The host calls check() on nearly every operation. Re-reading each cited
    // source repeats once per event-loop turn for the same evidence; the stamp
    // above still runs every time, and take()/valid() re-verify before use.
    const evidenceChecks = new TurnMemo();
    const check = () => {
      signal.throwIfAborted(); service.assertProfile(profileId); input.assertCurrent?.();
      modelContext?.assertCurrent();
      sessionPolicy?.assertCurrent();
      if (phase === "preflight") preflightDeadline.throwIfAborted();
      if (stamp !== this.authority(profileId) || serialized !== JSON.stringify(this.configuration(profileId))) {
        throw serviceError("MEMORY_SCOPE_REVOKED", "自动召回期间记忆、来源或设置已经变化");
      }
      const sessionId = this.sessionId(input);
      evidenceChecks.get(JSON.stringify([[...evidence.keys()], borrowedMemoryRefs, sessionId]), () => {
        if (!this.evidenceCurrent(profileId, [...evidence.values()], borrowedMemoryRefs, sessionId)) throw serviceError("MEMORY_SOURCE_CHANGED", "自动召回引用的文件已经变化");
        return true;
      });
    };
    const searchInput = { profileId, workspace: input.run.workspace, maxSensitivity: "private", signal, run: input.run };
    const projectKeys = workspaceMemoryRefs(input.run.workspace, "project");
    const remember = (relative, source, hash, retained) => {
      const key = `${source}:${relative}`, previous = evidence.get(key);
      if (!hash) throw serviceError("MEMORY_SOURCE_CHANGED", "自动召回引用的文件已经变化");
      if (previous) {
        // A later read of the same file may see appended entries. Keep the
        // original proof, never widened, while its proven prefix still holds.
        if (previous.hash === hash || previous.prefixHash !== undefined && evidenceCurrent(host.searchIndex, previous)) return;
        throw serviceError("MEMORY_SOURCE_CHANGED", "自动召回引用的文件已经变化");
      }
      evidence.set(key, retained || captureEvidence(host.searchIndex, relative, source, hash));
    };
    const rememberIndexed = results => {
      for (const result of results) {
        if (result.borrowed === true) {
          const refs = extractBorrowedMemoryRefs(result);
          if (!refs.length) throw serviceError("MEMORY_SHARED_READ_INVALID", "借阅记忆缺少可信来源依赖");
          borrowedMemoryRefs = mergeBorrowedMemoryRefs(borrowedMemoryRefs, refs);
          continue;
        }
        const source = result.source || "memory";
        const indexed = host.searchIndex.db.prepare("SELECT hash FROM memory_index_sources WHERE path=? AND source=?").get(result.path, source);
        remember(result.path, source, indexed?.hash);
        if (source === "sessions" && historyHits.size < 24) {
          historyHits.set(JSON.stringify([result.path, result.startLine, result.endLine]), result);
        }
      }
      check();
    };
    const receipt = content => ({ content, stamp, config: serialized, evidence: [...evidence.values()], borrowedMemoryRefs,
      ...(borrowedMemoryDerived ? { borrowedMemoryDerived: true, persistPolicy: "reference_only" } : {}), parentSignal: signal,
      assertParentCurrent: () => { input.assertCurrent?.(); modelContext?.assertCurrent(); sessionPolicy?.assertCurrent(); }, expiresAt: service.now() + config.cacheTtlMs,
      revision: sha256(`${stamp}:${JSON.stringify([...evidence.values()])}:${content}`) });
    try {
      check();
      const { session, messages, recentTurns } = this.conversationContext(input, host); searchInput.sessionId = session.id;
      const queryProvenance = this.queryProvenance(input, session);
      borrowedMemoryDerived = queryProvenance.derived; borrowedMemoryRefs = queryProvenance.refs; check();
      if (borrowedMemoryRefs.length) service.sharing.registerDependencies(searchInput, borrowedMemoryRefs);
      const effectiveInput = { ...input, query: queryProvenance.query };
      sessionPolicy = await service.activeMemoryCommands.policy(session.sessionKey); check();
      if (sessionPolicy.disabled) return null;
      const sessionScope = service.activeMemoryCommands.scope(session.sessionKey, check);
      await host.searchIndex.sync({ signal: AbortSignal.any([signal, preflightDeadline]) }); check();
      modelContext = service.resolveModelContext?.({ profileId, ...(session ? { sessionKey: session.sessionKey } : {}) }); check();
      const query = core.buildActiveMemoryQuery({ latestUserMessage: effectiveInput.query, recentTurns, config });
      const searchQuery = core.buildActiveMemorySearchQuery({ latestUserMessage: effectiveInput.query, recentTurns });
      // Defaults and explicit aliases both need a current Runtime resolution.
      // Until the host freezes that route, its proof stays local to this run.
      let proof, proofKey;
      // Native run reuse retains fulfilled failures until agent_end as well as
      // successes. Cross-turn cache eligibility must not change that scope ID.
      const selectProof = () => {
        const reusableModel = modelContext ? Boolean(modelContext.selectedModel)
          : Boolean(config.model || input.profile.defaultModel || config.modelFallback);
        proofKey = sha256(JSON.stringify([profileId, session?.sessionKey ?? input.run.id, input.run.workspace, query, searchQuery, cacheStamp, serialized, modelContext?.fingerprint, sessionPolicy?.revision]));
        proof = runEntry.proofs.get(proofKey);
        if (!proof || !this.evidenceCurrent(profileId, proof.evidence, proof.borrowedMemoryRefs || [], session.id)) {
          proof = reusableModel ? this.cacheProofs.get(proofKey) : undefined;
          if (!proof?.ready || proof.borrowedMemoryRefs?.length || proof.borrowedMemoryDerived || proof.expiresAt <= service.now() || !this.evidenceCurrent(profileId, proof.evidence, proof.borrowedMemoryRefs || [], session.id)) {
            proof = { id: crypto.randomUUID(), ready: false, evidence: [], borrowedMemoryRefs: [], expiresAt: service.now() + config.cacheTtlMs };
            this.cacheProofs.delete(proofKey);
            if (reusableModel) this.cacheProofs.set(proofKey, proof);
            while (this.cacheProofs.size > core.ACTIVE_MEMORY_MAX_CACHE_ENTRIES) this.cacheProofs.delete(this.cacheProofs.keys().next().value);
          }
          runEntry.proofs.set(proofKey, proof);
        }
        for (const item of proof.evidence) remember(item.path, item.source, item.hash, item);
        borrowedMemoryRefs = mergeBorrowedMemoryRefs(borrowedMemoryRefs, proof.borrowedMemoryRefs || []);
        check();
        return `${this.instance}:${proof.id}`;
      };
      const authorityFingerprint = selectProof();
      check(); phase = "recall";
      const createRuntime = (passConfig, passRuntimeConfig) => new ActiveMemoryRuntime({ host, input: { ...effectiveInput, session }, config: passConfig, runtimeConfig: passRuntimeConfig,
        modelContext, initialSearchQuery: searchQuery, complete: request => service.complete(request), signal, check, logger: service.logger, borrowedMemoryRefs, borrowedMemoryDerived,
        // Retention is a private diagnostic copy, not new recall authority. A
        // cancelled model may finish its original cleanup while its Profile and
        // retention setting still exist; no fresh source/model read is granted.
        assertTranscriptCurrent: () => {
          const current = this.configuration(profileId);
          if (service.hosts.get(profileId) !== host || !service.profiles().some(profile => profile.id === profileId)
            || !current?.persistTranscripts || current.transcriptDir !== config.transcriptDir) {
            throw serviceError("MEMORY_ACTIVE_TRANSCRIPT_SCOPE_INVALID", "自动召回诊断文件归属或留存设置已变化");
          }
        },
        // Let the original hook decide eligibility and strong trigger matches
        // first. Freeze the actual model before its native recall/cache lookup.
        prepareRecall: async recallSignal => {
          runEntry.statusPhase = "recalling"; stage = "model-route";
          const discoverySignal = AbortSignal.any([signal, recallSignal]);
          const checkDiscovery = () => { discoverySignal.throwIfAborted(); check(); };
          checkDiscovery();
          if (service.prepareModelContext) {
            const routeFingerprint = modelContext?.fingerprint;
            if (runEntry.resolvedModel) {
              if (routeFingerprint !== runEntry.resolvedModel.routeFingerprint) throw serviceError("MEMORY_IMPORT_BINDING_STALE", "自动召回的模型路由变化");
              modelContext = runEntry.resolvedModel.context;
            } else {
              modelContext = await service.prepareModelContext({ profileId, sessionKey: session.sessionKey,
                ...(config.model ? { model: config.model } : {}),
                signal: discoverySignal, assertCurrent: checkDiscovery });
              checkDiscovery();
              // Native selection puts the fallback after an actual CLI
              // default. Only an absent candidate reaches this second probe;
              // a model failure never retries on the fallback route.
              if (!config.model && !modelContext?.currentModel && !modelContext?.defaultModel && config.modelFallback) {
                modelContext = await service.prepareModelContext({ profileId, sessionKey: session.sessionKey,
                  model: config.modelFallback, signal: discoverySignal, assertCurrent: checkDiscovery });
                checkDiscovery();
              }
              runEntry.resolvedModel = { routeFingerprint, context: modelContext };
            }
          }
          checkDiscovery();
          const selected = { modelContext, authorityFingerprint: selectProof() };
          stage = "recall"; return selected;
        },
        callTool: async (tool, args, toolSignal, conversationRecall) => {
          toolSignal.throwIfAborted(); check();
          let result;
          if (tool === "memory_search") {
            if (Object.keys(args).some(key => !["query", "maxResults", "minScore"].includes(key))
              || typeof args.query !== "string" || args.query.length > 4096) throw serviceError("MEMORY_ACTIVE_TOOL_INVALID", "自动召回查询无效");
            const sources = conversationRecall?.corpus === "sessions" ? ["sessions"]
              : conversationRecall?.corpus === "configured" ? host.searchIndex.resolveSettings().resolved?.sources : undefined;
            const found = await service.searchMemory({ ...searchInput, ...args, sources, signal: toolSignal,
              // The configured lane includes authorized file memory alongside
              // this Agent's private history. Only the sessions-only lane is
              // restricted to own memory; the sharing broker never borrows
              // another Agent's raw session corpus.
              ...(conversationRecall?.corpus === "sessions" ? { memoryScope: "own" } : {}) });
            rememberIndexed(found.results);
            result = { results: found.results };
          } else {
            // File-active opt-outs keep the independent private history lane.
            // Its sessions-only authority must not become a Markdown getter.
            if (conversationRecall?.corpus === "sessions") throw serviceError("MEMORY_ACTIVE_SCOPE_INVALID", "跨会话回忆不能读取文件记忆");
            if (tool !== "memory_get" || Object.keys(args).some(key => !["path", "from", "lines"].includes(key))) throw serviceError("MEMORY_ACTIVE_TOOL_INVALID", "自动召回文件请求无效");
            if (service.sharing?.recognizes(args.path)) {
              const found = service.getFile({ ...searchInput, ...args });
              borrowedMemoryRefs = mergeBorrowedMemoryRefs(borrowedMemoryRefs, extractBorrowedMemoryRefs(found));
              result = found;
            } else {
              const before = host.searchIndex.readIndexedSource(args.path, "memory");
              const found = service.getFile({ ...searchInput, ...args });
              remember(found.path, "memory", before.hash);
              result = { path: found.path, text: found.text, from: found.from, lines: found.lines };
            }
          }
          toolSignal.throwIfAborted(); check(); return result;
        }, diagnose });
      const hookInput = { messages, runId: runEntry.nativeId, sessionScope,
        authorityFingerprint, activeProjectKeys: projectKeys,
        registerAgentEnd: handler => { runEntry.agentEnd = handler; },
        triggerSearch: async (text, options) => {
          check();
          if (options.lexicalOnly !== true || JSON.stringify(options.sources) !== '["memory"]'
            || JSON.stringify(options.activeProjectKeys) !== JSON.stringify(projectKeys)) throw serviceError("MEMORY_ACTIVE_SCOPE_INVALID", "自动召回检索范围无效");
          // Lane-one candidates are not all injected and upstream picks the
          // strong ones internally, so none of them count as recall signals.
          let own;
          const found = await service.searchMemory({ ...searchInput, query: text, maxResults: options.maxResults,
            minScore: options.minScore, sources: ["memory"], lexicalOnly: true, record: false,
            signal: AbortSignal.any([signal, options.signal]) }, results => { own = results; });
          rememberIndexed(found.results);
          const byRange = result => JSON.stringify([result.path, result.startLine, result.endLine]);
          const shortTerm = new Map((own || []).filter(result => result.source === "memory"
            && isShortTerm(result.path) && core.isAutomaticMemoryEntryEligible(result))
            .map(result => [byRange(result), result]));
          if (!shortTerm.size || effectiveInput.query.length > 4096) return presentTriggerCandidates(found.results, effectiveInput.query);
          const queryTags = new Set(core.deriveConceptTags({ path: "", snippet: effectiveInput.query }));
          const ownCandidate = result => result.borrowed === true ? undefined : shortTerm.get(byRange(result));
          const candidates = found.results.flatMap(result => {
            const original = ownCandidate(result);
            if (!original) return [result];
            // Short-term files have no curated triggers. Use two matching
            // concepts from the authorized lexical hit, without editing it.
            const tags = core.deriveConceptTags({ path: "", snippet: original.snippet }).filter(tag => queryTags.has(tag));
            if (tags.length < 2) return [];
            return [{ ...original, triggers: tags.slice(0, 2).join(" ") }];
          });
          const presented = presentTriggerCandidates(candidates, effectiveInput.query);
          for (const hit of presented) {
            const original = ownCandidate(hit);
            if (original) fastCandidates.set(hit, original);
          }
          return presented;
        },
        triggerCandidates: async options => {
          check();
          if (JSON.stringify(options.activeProjectKeys) !== JSON.stringify(projectKeys)) throw serviceError("MEMORY_ACTIVE_SCOPE_INVALID", "自动召回检索范围无效");
          const candidates = await service.searchScope.run(searchInput,
            () => host.run(() => host.searchIndex.listTriggerCandidates({ ...options, limit: 24, signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]) })));
          const allowed = candidates.filter(item => service.allowResult(profileId, item, searchInput));
          const shared = service.sharedTriggers ? await service.sharedTriggers(searchInput, { ...options, query: searchQuery, maxResults: 24 }, allowed) : { results: allowed };
          rememberIndexed(shared.results); return presentTriggerCandidates(shared.results, effectiveInput.query);
        } };
      const runPass = runtime => {
        this.runtimes.add(runtime); void runtime.settled.then(() => this.runtimes.delete(runtime));
        return runtime.beforePromptBuild(hookInput);
      };
      let runtime = createRuntime(config, service.config(profileId));
      let result = await runPass(runtime);
      if (this.wantsLocalizedRecall(config, result, effectiveInput.query)) {
        // The first instance is closed. A fresh one for the same parent turn,
        // permissions, cancellation and model route runs deep recall once;
        // both instances' end handlers still run when the turn ends.
        const first = runEntry.agentEnd;
        hookInput.registerAgentEnd = handler => {
          runEntry.agentEnd = first ? (...args) => { try { first(...args); } finally { handler(...args); } } : handler;
        };
        check();
        runtime = createRuntime({ ...config, mode: "always" }, withAlwaysMode(service.config(profileId)));
        result = await runPass(runtime);
      }
      // Failed and timed-out recalls return normally rather than throwing.
      const nativeStatus = runtime.nativeResult?.status;
      if (["failed", "timeout", "unavailable"].includes(nativeStatus)) diagnose({ stage: "recall-result", outcome: nativeStatus });
      stage = "evidence";
      check();
      try { await this.status.capture({ input: { ...input, session }, runtime, evidence: [...evidence.values()], borrowedMemoryRefs, check }); }
      catch { service.logger.warn?.("active-memory: status display receipt unavailable"); }
      check();
      proof.evidence = [...evidence.values()];
      proof.borrowedMemoryRefs = borrowedMemoryRefs; proof.borrowedMemoryDerived = borrowedMemoryDerived;
      if (this.cacheProofs.get(proofKey) === proof) {
        if (!borrowedMemoryDerived && !borrowedMemoryRefs.length && !runtime.privateTranscriptRecall && runtime.nativeResult && core.shouldCacheResult(runtime.nativeResult)) {
          proof.ready = true;
          proof.expiresAt = service.now() + config.cacheTtlMs;
        } else this.cacheProofs.delete(proofKey);
      }
      const fastRecalls = (result?.deliveredMatches || []).flatMap(match => {
        const original = fastCandidates.get(match.shoggothTriggerResult);
        const recallEvidence = original && evidence.get(`memory:${original.path}`);
        return recallEvidence ? [{ ...original, recallEvidence }] : [];
      });
      if (nativeStatus === "ok" && result?.prependContext && historyHits.size) {
        // A tool result used by the auxiliary model is not proof of what the
        // main model received. Only its verbatim sourced excerpt can count.
        try {
          const rows = [...historyHits.values()].flatMap(hit => {
            const sessionId = host.searchIndex.sessionIdForPath(hit.path);
            const page = service.conversationRecall.scanEligibleSession({ profileId, sessionId,
              afterSeq: hit.startLine - 1, limit: 24, completedOnly: true });
            return page.events.filter(event => event.seq <= hit.endLine)
              .map(event => ({ sessionId, eventId: event.eventId, snippet: hit.snippet, score: hit.score }));
          });
          const context = result.prependContext.replace(/\s+/gu, " ");
          const summary = runtime.nativeResult.summary.replace(/\s+/gu, " ");
          fastRecalls.push(...service.recallSignals.historyCandidates(searchInput, rows)
            .filter(candidate => summary.includes(candidate.history.excerpt) && context.includes(candidate.history.excerpt)));
        } catch { /* Keep the authorized recall even if counting is unavailable. */ }
      }
      return { ...receipt(this.borrowedContext(result?.prependContext || "", borrowedMemoryRefs)), fastRecalls };
    } catch (error) {
      const discarded = reason => { diagnose({ stage, outcome: "discarded", code: reason }); return null; };
      if (signal.aborted) return discarded("CANCELED");
      if (["MEMORY_ACTIVE_SESSION_INVALID", "CHAT_SESSION_INVALID", "MEMORY_COMMAND_SESSION_UNAVAILABLE",
        "MEMORY_COMMAND_STATE_INVALID", "MEMORY_COMMAND_STALE"].includes(error.code)) return discarded(error.code);
      if (stamp !== this.authority(profileId)) return discarded("AUTHORITY_CHANGED");
      if (!this.evidenceCurrent(profileId, [...evidence.values()], borrowedMemoryRefs, this.sessionId(input))) return discarded("EVIDENCE_CHANGED");
      try { input.assertCurrent?.(); modelContext?.assertCurrent(); sessionPolicy?.assertCurrent(); } catch { return discarded("PARENT_CHANGED"); }
      diagnose({ stage, outcome: "error", code: diagnosticCode(error) });
      return receipt(core.buildRecallOutcomePrefix("unavailable"));
    } finally { runEntry.statusPhase = "settled"; }
  }
}

module.exports = { ActiveMemory };
