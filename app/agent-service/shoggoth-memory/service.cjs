"use strict";
const { isUiActionSubmission } = require("../ui-input-provenance");

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { RecallPolicyStore } = require("../recall-policy-store");
const { validateMemoryItem } = require("../memory-store");
const { hasSecret, hasPii, memoryTrust, matchesWorkspace, workspaceMemoryRefs, contentHash } = require("../memory-engine");
const { serviceError } = require("../security");
const { FileMemoryStore } = require("./file-store.cjs");
const { MemoryDatabase } = require("./database.cjs");
const { ShoggothMemoryMigration, sha256 } = require("./migration.cjs");
const { LegacyMemoryReader } = require("./legacy-reader.cjs");
const { ShoggothMemoryHost, core } = require("./host.cjs");
const { MemorySearchIndex } = require("./search-index.cjs");
const { ProductMemorySessions } = require("./session-source.cjs");
const { readPrivateFile } = require("../private-file");
const { MemoryMaintenance } = require("./maintenance.cjs");
const { SharedReadService } = require("./shared-read-service.cjs");
const { isBorrowedMemoryDerived, assertNoBorrowedMemoryWrite } = require("./borrowed-memory-provenance.cjs");
const { ActiveMemory } = require("./active-memory.cjs");
const { ActiveMemoryCommands } = require("./active-memory-commands.cjs");
const { recoverActiveMemorySessions } = require("./active-memory-state.cjs");
const { MemoryLocalEmbeddingHost } = require("./local-embedding-host.cjs");
const { MemoryRemoteProviderResources } = require("./remote-provider-resources.cjs");

const FIELDS = ["id", "profileId", "scope", "type", "content", "sourceRefs", "confidence", "sensitivity", "status", "validFrom", "validUntil", "supersedes", "createdAt", "updatedAt"];
const validate = item => validateMemoryItem(Object.fromEntries(FIELDS.map(key => [key, item[key]])));
const fail = (code, message) => { throw serviceError(code, message); };

class ShoggothMemoryService {
  constructor({ paths, profiles, definitionStore, transcriptStore, chatSessionStore, candidateStore,
    now = Date.now, randomUUID = crypto.randomUUID, getConfig = () => ({}), logger = console, remoteProviderResources, projectProviderMetadata, sharingConfig, resolveRun, initialization = "fresh" }) {
    this.paths = paths; this.profiles = profiles; this.definitionStore = definitionStore;
    this.transcriptStore = transcriptStore; this.chatSessionStore = chatSessionStore;
    this.now = now; this.randomUUID = randomUUID; this.getConfig = getConfig; this.logger = logger;
    this.projectProviderMetadata = projectProviderMetadata; this.resolveRun = resolveRun;
    this.owner = "shoggoth-memory-core"; this.opened = false; this.hosts = new Map(); this.blockedProfiles = new Set();
    this.searchScope = new AsyncLocalStorage(); this.sourceAuthority = new AsyncLocalStorage(); this.jobs = new Map();
    this.profileControllers = new Map();
    this.remoteProviderResourcesInput = remoteProviderResources;
    this.remoteEmbeddingResources = this.createRemoteProviderResources();
    this.database = new MemoryDatabase({ paths, now });
    this.recallPolicy = new RecallPolicyStore({ paths, memoryStore: {}, transcriptStore, chatSessionStore,
      now, randomUUID, strictSourceResolution: true });
    if (!["fresh", "migration"].includes(initialization)) fail("MEMORY_INITIALIZATION_INVALID", "记忆初始化方式无效");
    this.legacy = initialization === "migration" ? new LegacyMemoryReader({ paths, recallPolicy: this.recallPolicy, candidateStore,
      now, getRecall: () => this.conversationRecall }) : null;
    this.migration = this.legacy ? new ShoggothMemoryMigration({ paths, now,
      readLegacy: id => this.legacy.read(id), assertLegacyCurrent: (...args) => this.legacy.assertCurrent(...args) }) : null;
    this.initialization = this.legacy ? null : new (require("./fresh-initialization.cjs").FreshMemoryInitialization)({ paths, database: this.database, now, randomUUID });
    this.store = new FileMemoryStore({ paths, database: this.database, migration: this.migration, initialization: this.initialization,
      getHost: id => this.host(id), now });
    this.recallPolicy.memoryStore = this.legacy?.store || this.store;
    this.sharing = new SharedReadService(this, { config: sharingConfig });
    this.maintenance = new MemoryMaintenance(this);
    this.activeMemory = new ActiveMemory(this);
    this.activeMemoryCommands = new ActiveMemoryCommands(this);
    this.localEmbeddingHost = new MemoryLocalEmbeddingHost({ getConfig: id => this.config(id),
      assertCurrent: id => this.assertProfile(id) });
  }
  createRemoteProviderResources() {
    const input = this.remoteProviderResourcesInput || {};
    return new MemoryRemoteProviderResources({ getConfig: id => this.config(id), assertCurrent: id => {
      this.assertProfile(id);
      if (this.profileControllers.get(id)?.signal.aborted) fail("MEMORY_SCOPE_REVOKED", "助理记忆已停止");
    }, resolveOwner: input.resolveOwner, secretStore: input.secretStore });
  }
  setSharingConfig(config) { this.sharing.setConfig(config); }
  borrowedMemoryDependenciesCurrent(profileId, sessionId, refs) { return this.sharing.dependenciesCurrent(profileId, sessionId, refs); }
  sharedTriggers(input, options, own) { return this.sharing.search({ ...input, query: options.query || input.query, lexicalOnly: true, candidateMode: "trigger", triggerOptions: options },
    { items: [], results: own || [], revision: this.store.getRevision(input.profileId), truncated: false }); }
  setReviewReceiptStore() {} // Only the immutable migration reader consumes old receipts.
  setProvenanceService(service) { this.provenance = service; }
  setSemanticSearchService(service) {
    this.semanticService = service;
    const { e5Identity } = require("../e5-model-contract"), { E5_RUNTIME } = require("../e5-encoder");
    this.embedding = { identity: `intfloat/multilingual-e5-small:${e5Identity(E5_RUNTIME.onnx, E5_RUNTIME.tokenizer)}`, encode: async (text, mode) => {
      await service.embedding.start();
      return service.embedding.request(mode === "query" ? "encode-query" : "encode-passage", { text }, { timeoutMs: 30_000 });
    } };
  }
  attach({ conversationRecall, complete, checkpointStore, resolveModelContext, prepareModelContext, getConfigProjection }) {
    this.conversationRecall = conversationRecall; this.checkpointStore = checkpointStore;
    this.resolveModelContext = resolveModelContext;
    const { memoryModelAliases, hasMemoryModelAliases } = require("./model-aliases.cjs");
    const selections = new WeakMap();
    const aliasesFor = profileId => memoryModelAliases(this.config(profileId), profileId);
    const authority = (profileId, aliases) => {
      const fingerprint = JSON.stringify([aliases, this.config(profileId)._shoggothConfigRevision]);
      return () => {
        this.assertProfile(profileId);
        if (JSON.stringify([aliasesFor(profileId), this.config(profileId)._shoggothConfigRevision]) !== fingerprint) {
          fail("MEMORY_IMPORT_BINDING_STALE", "记忆模型别名配置已经变化");
        }
      };
    };
    this.prepareModelContext = prepareModelContext && (async input => {
      const aliases = aliasesFor(input.profileId), assertAliasesCurrent = authority(input.profileId, aliases);
      assertAliasesCurrent(); input.assertCurrent?.();
      const selected = await prepareModelContext({ ...input,
        ...(hasMemoryModelAliases(aliases) ? { modelAliases: aliases } : {}),
        assertCurrent: () => { assertAliasesCurrent(); input.assertCurrent?.(); } });
      assertAliasesCurrent(); input.assertCurrent?.();
      if (selected?.selectedModel) selections.set(selected, { profileId: input.profileId, assertAliasesCurrent });
      return selected;
    });
    this.complete = complete && (async input => {
      const aliases = aliasesFor(input.profileId), assertAliasesCurrent = authority(input.profileId, aliases);
      const check = () => { assertAliasesCurrent(); input.assertCurrent?.(); };
      check();
      let selection = input.modelSelection;
      if (selection && input.model !== selection.selectedModel) fail("MEMORY_MODEL_SELECTION_INVALID", "记忆模型与选择凭证不一致");
      if (!selection && hasMemoryModelAliases(aliases)) {
        if (!this.prepareModelContext) fail("MODEL_ONLY_UNSUPPORTED", "当前 Runtime 无法确认配置的记忆模型别名");
        selection = await this.prepareModelContext({ profileId: input.profileId,
          ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}), ...(input.model ? { model: input.model } : {}),
          ...(input.signal ? { signal: input.signal } : {}), assertCurrent: check });
        if (!selection?.selectedModel) fail("MODEL_ONLY_UNSUPPORTED", "当前 Runtime 无法确认配置的记忆模型别名");
      }
      if (selection) {
        const receipt = selections.get(selection);
        if (!receipt || receipt.profileId !== input.profileId) fail("MEMORY_MODEL_SELECTION_INVALID", "记忆模型别名选择凭证无效");
        receipt.assertAliasesCurrent();
      }
      check();
      const result = await complete({ ...input, ...(selection ? { model: selection.selectedModel, modelSelection: selection } : {}),
        assertCurrent: () => { check(); if (selection) selections.get(selection).assertAliasesCurrent(); } });
      check(); return result;
    });
    this.getConfigProjection = getConfigProjection || (() => ({ revision: 0, config: this.getConfig() }));
  }
  assertProfile(id) {
    if (!this.opened || !this.profiles().some(profile => profile.id === id)) fail("MEMORY_SCOPE_REVOKED", "助理记忆已关闭或归属已变化");
    if (this.blockedProfiles.has(id)) fail("RECALL_POLICY_UNAVAILABLE", "此助理的撤回记录不可验证，记忆仍保留但暂不可读取");
    const authority = this.sourceAuthority.getStore();
    if (authority?.profileId === id && authority.stamp !== this.sourcePolicyStamp(id)) fail("MEMORY_SOURCE_REVOKED", "整理期间原始会话或撤回策略已经变化");
  }
  open(profileIds = []) {
    if (this.remoteEmbeddingResources.closed) this.remoteEmbeddingResources = this.createRemoteProviderResources();
    if (this.localEmbeddingHost.closed) this.localEmbeddingHost = new MemoryLocalEmbeddingHost({
      getConfig: id => this.config(id), assertCurrent: id => this.assertProfile(id) });
    this.store.open(); this.legacy?.open(); this.opened = true;
    this.recallPolicy.memoryStore = this.legacy?.store || this.store; this.recallPolicy.open([]);
    try {
      this.blockedProfiles.clear();
      for (const id of profileIds) {
        try { this.store.ensureProfile(id); }
        catch (error) { if (error.code !== "RECALL_POLICY_UNAVAILABLE") throw error; this.blockedProfiles.add(id); }
      }
      this.recallPolicy.memoryStore = this.store;
      for (const id of profileIds) if (!this.blockedProfiles.has(id)) this.recallPolicy.assertReady(id);
      this.maintenance.open();
    } catch (error) { this.opened = false; throw error; }
  }
  async close() {
    this.sharing.close();
    this.opened = false;
    for (const controller of this.profileControllers.values()) controller.abort();
    const remoteClosing = Promise.resolve().then(() => this.remoteEmbeddingResources.close());
    remoteClosing.catch(() => {});
    // Each existing owner must physically join even if another cleanup fails.
    // Keep storage until all producer and provider cleanup succeeds so a
    // failed retirement can still be retried with its original evidence.
    const outcomes = await Promise.allSettled([
      ...[...this.hosts.values()].map(async host => host.searchIndex.close()),
      Promise.resolve().then(() => this.maintenance.close()),
      Promise.resolve().then(() => this.activeMemory.close()),
      Promise.allSettled([...this.jobs.values()]),
    ]);
    const resources = await Promise.allSettled([
      remoteClosing, Promise.resolve().then(() => this.localEmbeddingHost.close()),
    ]);
    const failures = [...outcomes, ...resources].filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Memory resources did not retire");
    for (const host of this.hosts.values()) host.database.close();
    this.hosts.clear(); this.legacy?.close(); this.recallPolicy.close(); this.store.close(); this.database.close();
    this.profileControllers.clear();
  }
  profileSignal(profileId) {
    if (!this.profileControllers.has(profileId)) this.profileControllers.set(profileId, new AbortController());
    return this.profileControllers.get(profileId).signal;
  }
  async stopProfile(profileId) {
    this.profileSignal(profileId); this.profileControllers.get(profileId).abort();
    await this.sharing.reconcileConfig();
    await Promise.allSettled([this.jobs.get(profileId),
      this.activeMemory.stopProfile(profileId),
      ...[...this.maintenance.pending].filter(([key]) => key === `dream:${profileId}` || key.startsWith(`flush:${profileId}:`)).map(([, task]) => task),
      ...[...this.activeMemory.pending].filter(([key]) => JSON.parse(key)[0] === profileId).map(([, task]) => task)].filter(Boolean));
    const host = this.hosts.get(profileId);
    if (host) {
      // Retention must physically retire observers, sync/provider work and
      // SQLite leases before it removes this Profile's persistent directory.
      await host.searchIndex.close();
      host.database.close();
      this.hosts.delete(profileId);
    }
  }
  resumeProfile(profileId) { this.profileControllers.delete(profileId); }
  async retireProviderOwners({ agentIds }) {
    const selected = new Set(agentIds);
    // This private cleanup callback follows catalog admission withdrawal.
    // Its management signal can already be aborted; that cannot cancel the
    // mandatory physical join. A stopping Profile still owns its host until
    // stopProfile finishes, and must also retire before key cleanup proceeds.
    // No host is created for unused or fully stopped Profiles.
    const indexes = [...this.hosts].filter(([id]) => selected.has(id));
    const outcomes = await Promise.allSettled(indexes.map(async ([, host]) => host.searchIndex.retireProviderOwner()));
    const failures = outcomes.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Memory provider owners did not retire");
  }
  async reconcileConfig() {
    if (!this.opened) fail("MEMORY_SCOPE_REVOKED", "助理记忆已关闭");
    // Revoke and physically join only recall work using the old policy. An
    // idempotent projection read and runs using the new policy stay active.
    await this.activeMemory.reconcileConfig();
    // Applying policy updates only already-owned indexes. A stopped or unused
    // Profile does not acquire storage, a provider, or a model from this path.
    const indexes = [...this.hosts].filter(([profileId]) => !this.profileControllers.get(profileId)?.signal.aborted);
    const outcomes = await Promise.allSettled(indexes.map(async ([profileId, host]) => {
      try {
        await core.runInMemoryBackgroundContext(() => host.searchIndex.sync({ nativeParams: { reason: "config" } }));
      } catch (error) {
        // Profile retirement is authoritative and resumes with the latest
        // saved policy. It need not reopen a generation just to acknowledge it.
        if (this.opened && this.profileControllers.get(profileId)?.signal.aborted) return;
        throw error;
      }
    }));
    if (!this.opened) fail("MEMORY_SCOPE_REVOKED", "助理记忆已关闭");
    const failed = outcomes.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  host(profileId) {
    this.assertProfile(profileId);
    if (this.hosts.has(profileId)) return this.hosts.get(profileId);
    // A stopped Profile may retain ordinary reads for cleanup, but it cannot
    // acquire a new index/observer owner until explicit lifecycle resumption.
    if (this.profileControllers.get(profileId)?.signal.aborted) {
      fail("MEMORY_SCOPE_REVOKED", "助理记忆已停止，无法重新打开索引");
    }
    const workspaceDir = this.store.workspace(profileId);
    const database = new MemoryDatabase({ paths: this.paths, now: this.now,
      databasePath: path.join(this.paths.agentsDir, profileId, "memory-core.sqlite") }); database.open();
    let activeMemoryRecovery;
    try { activeMemoryRecovery = recoverActiveMemorySessions(database, profileId); }
    catch (error) { database.close(); throw error; }
    const sessions = new ProductMemorySessions({ sessions: this.chatSessionStore, transcripts: this.transcriptStore,
      recall: this.conversationRecall, database, assertProfile: id => this.assertProfile(id) });
    const host = new ShoggothMemoryHost({ database, paths: this.paths, profileId, workspaceDir,
      roster: () => this.rosterView(),
      sessions, assertCurrent: () => this.assertProfile(profileId) });
    host.activeMemoryRecovery = activeMemoryRecovery;
    if (activeMemoryRecovery.unresolved) this.logger.warn?.(`active-memory: Profile ${profileId} has ${activeMemoryRecovery.unresolved} unverified scratch records; recall paused`);
    new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true, embedding: this.embedding,
      getConfig: () => this.config(profileId),
      acquireLocalService: this.localEmbeddingHost.acquireLocalService,
      assertLocalEmbeddingConfig: this.localEmbeddingHost.assertLocalEmbeddingConfig,
      runLocalEmbedding: this.localEmbeddingHost.runLocalEmbedding,
      remoteEmbeddingResources: this.remoteEmbeddingResources,
      allow: result => this.allowResult(profileId, result, this.searchScope.getStore()), logger: this.logger });
    this.hosts.set(profileId, host);
    return host;
  }
  forgetProfile(profileId) {
    const host = this.hosts.get(profileId); this.hosts.delete(profileId);
    if (host) { host.searchIndex.db = null; host.database.close(); }
  }
  viewStatus(profileId) { if (this.blockedProfiles.has(profileId)) return { stale: true, revision: null, code: "RECALL_POLICY_UNAVAILABLE" };
    return { stale: false, revision: this.store.getRevision(profileId), owner: this.owner,
    workspace: this.store.workspace(profileId), upstreamRevision: "c10679395819ede78bb073f979f95c157e165bfa" }; }
  rebuildViews(profileId) { this.assertProfile(profileId); return this.viewStatus(profileId); }
  readCanonical(profileId, kind) {
    this.assertProfile(profileId);
    if (!["MEMORY", "USER"].includes(kind)) fail("MEMORY_PATH_NOT_ALLOWED", "不是核心记忆文件");
    return { kind, content: this.store.readFile(profileId, `${kind}.md`), revision: this.store.getRevision(profileId), readOnly: true };
  }
  isReviewCommitted(profileId, item) { return item?.profileId === profileId && this.isRecallCommitted(profileId, item); }
  isReviewReceipted(profileId, item) { return this.isReviewCommitted(profileId, item)
    || Boolean(this.legacy?.verifier.isReviewReceipted(profileId, item)); }
  isRecallCommitted(profileId, item) {
    if (!item || item.profileId !== profileId || memoryTrust(item) === "untrusted") return false;
    const current = this.store.get(profileId, item.id);
    return Boolean(current && current.status === "active" && current.content === item.content
      && this.recallPolicy.isMemoryVisible(profileId, current));
  }
  visible(item, input = {}) {
    if (!item || item.status !== "active" || item.validFrom > this.now() || item.validUntil !== null && item.validUntil <= this.now()
      || item.sensitivity === "restricted" || item.sensitivity === "private" && input.maxSensitivity !== "private"
      || hasSecret(item.content) || memoryTrust(item) === "untrusted"
      || ["project", "workspace"].includes(item.scope) && !matchesWorkspace(item, input.workspace)
      || !this.recallPolicy.isMemoryVisible(item.profileId, item)) return false;
    if (input.scopes && !input.scopes.includes(item.scope)) return false;
    const authorityText = item.authorityText || item.content;
    const annotation = core.extractCuratedEntryRecallMetadata({ sourceLines: authorityText.split("\n"), curatedRoot: true, projectScopeEligible: true });
    if (annotation.projectKey && !annotation.projectKey.split("; ").every(key => workspaceMemoryRefs(input.workspace, "project").includes(key))) return false;
    if (item.sourceEvidence && !this.sourceEvidenceVisible(item.profileId, item.sourceEvidence, input.workspace)) return false;
    return this.sourceSessionsVisible(item.profileId, authorityText, input.workspace, { memoryItem: item });
  }
  sourceEvidenceVisible(profileId, evidence, workspace) {
    const host = this.host(profileId);
    for (const source of evidence) {
      try {
        const session = host.sessions.current(profileId, source.sessionId);
        if (session.workspace !== workspace) return false;
        const page = this.conversationRecall.scanEligibleSession({ profileId, sessionId: source.sessionId, afterSeq: source.seq - 1, limit: 1, completedOnly: true });
        const event = page.events.find(item => item.seq === source.seq);
        if (!event || isBorrowedMemoryDerived(event) || sha256(`${event.kind === "user" ? "User" : "Assistant"}: ${event.text.replace(/\s+/gu, " ").trim()}`) !== source.hash) return false;
      } catch { return false; }
    }
    return true;
  }
  sourceSessionsVisible(profileId, text, workspace, { visited = new Set(), memoryItem = null } = {}) {
    // Raw projections and recursive sources cannot inherit a saved item's authorization.
    if (visited.size > 32 || this.recallPolicy.hasRevokedContent(profileId, text,
      { memoryItem: memoryItem?.projection ? null : memoryItem })) return false;
    const keys = core.extractPromotionKeys(text), host = this.host(profileId);
    const references = [...text.matchAll(/\[[^\]\s]+\/sessions\/(?:[^/\s]+\/)?([^#\s\]]+)#L(\d+)\]\s*([^\n]*)/gu)];
    const ids = new Set(references.map(match => match[1]));
    for (const match of references) {
      try {
        const page = this.conversationRecall.scanEligibleSession({ profileId, sessionId: match[1], afterSeq: Number(match[2]) - 1, limit: 1, completedOnly: true });
        const event = page.events.find(item => item.seq === Number(match[2]));
        if (!event || isBorrowedMemoryDerived(event)) return false;
        const current = `${event.kind === "user" ? "User" : "Assistant"}: ${event.text.replace(/\s+/gu, " ").trim()}`;
        if (match[3] && !current.startsWith(match[3].replace(/…$/, "").trimEnd())) return false;
      } catch { return false; }
    }
    // Keyed promotions have exact persisted paths, including ../library/ paths.
    // Parsing their rendered citation again would mistake an external suffix
    // for the Profile's canonical memory/<basename>.
    const evidence = keys.length ? [] : [...text.matchAll(/\b(memory\/[^\n`<>]*?\.(?:txt|md))(?::(\d+)-(\d+)|#L(\d+)-L(\d+))/gu)]
      .map(match => ({ path: match[1], startLine: Number(match[2] || match[4]), endLine: Number(match[3] || match[5]) }));
    for (const key of keys) {
      if (visited.has(key)) return false;
      visited.add(key);
      const stateKey = `${core.memoryCoreWorkspaceStateKey(host.workspaceDir)}:${sha256(key)}`;
      const row = host.database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=? AND value IS NOT NULL")
        .get(core.SHORT_TERM_RECALL_NAMESPACE, stateKey);
      const retained = host.database.db.prepare("SELECT path,start_line AS startLine,end_line AS endLine,source_hash AS sourceHash FROM memory_promotion_sources WHERE state_key=?").get(stateKey);
      const candidate = retained || (row && JSON.parse(row.value).value);
      if (!candidate) return false;
      evidence.push(candidate);
    }
    for (const source of evidence) {
      const identity = `${source.path}:${source.startLine}:${source.endLine}`;
      if (visited.has(identity)) return false;
      const nextVisited = new Set(visited); nextVisited.add(identity);
      try {
        const relative = path.posix.normalize(source.path), absolute = path.resolve(host.workspaceDir, relative);
        if (relative !== source.path || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative)
          || !Number.isSafeInteger(source.startLine) || source.startLine < 1 || !Number.isSafeInteger(source.endLine)
          || source.endLine < source.startLine || source.endLine - source.startLine > 1000) return false;
        const external = host.searchIndex.sourceFiles.isExtra(relative);
        let content;
        if (external) {
          // A file published before its promotion receipt failed must stay
          // invisible; an uncommitted short-term candidate is not proof.
          if (!source.sourceHash) return false;
          const file = host.searchIndex.sourceFiles.read(relative);
          const projectKeys = host.searchIndex.prepareSourceChunks(relative, "memory", file)
            .filter(chunk => chunk.startLine <= source.endLine && chunk.endLine >= source.startLine)
            .flatMap(chunk => chunk.projectKey?.split("; ") || []);
          if (projectKeys.some(key => !workspaceMemoryRefs(workspace, "project").includes(key))) return false;
          content = file.text;
        } else {
          const internalCorpus = /^memory\/\.dreams\/session-corpus\/\d{4}-\d{2}-\d{2}\.txt$/u.test(relative);
          if ((!internalCorpus && !host.searchIndex.sourceFiles.isManaged(relative)) || fs.realpathSync.native(absolute) !== absolute) return false;
          content = readPrivateFile(absolute, { maxBytes: 16 * 1024 * 1024 }).toString("utf8");
          if (internalCorpus) {
            // Corpus files are indirect provenance only. Every cited line must
            // still bind to this owner's eligible Product event; neither this
            // check nor SharedReadPolicy grants direct corpus read access.
            const lines = content.split("\n").slice(source.startLine - 1, source.endLine);
            if (lines.length !== source.endLine - source.startLine + 1 || lines.some(line => {
              const match = /^\[([^/\s\]]+)\/sessions\/(?:[^/\s]+\/)?([^#\s\]]+)#L(\d+)\]\s+(.+)$/u.exec(line);
              if (!match || match[1] !== profileId) return true;
              const session = host.sessions.current(profileId, match[2]);
              if (session.workspace !== workspace) return true;
              const page = this.conversationRecall.scanEligibleSession({ profileId, sessionId: match[2], afterSeq: Number(match[3]) - 1, limit: 1, completedOnly: true });
              const event = page.events.find(item => item.seq === Number(match[3]));
              if (!event || isBorrowedMemoryDerived(event)) return true;
              const current = `${event.kind === "user" ? "User" : "Assistant"}: ${event.text.replace(/\s+/gu, " ").trim()}`;
              return !current.startsWith(match[4].replace(/…$/, "").trimEnd());
            })) return false;
          }
        }
        const fragment = content.split("\n").slice(source.startLine - 1, source.endLine).join("\n");
        if (source.sourceHash && sha256(fragment) !== source.sourceHash) return false;
        const bound = this.store.list(profileId, { status: "active" }).filter(item => item.memoryPath === relative
          && item.startLine <= source.endLine && item.endLine >= source.startLine);
        if (bound.some(item => item.sourceEvidence && !this.sourceEvidenceVisible(profileId, item.sourceEvidence, workspace))) return false;
        if (!fragment.trim() || !this.sourceSessionsVisible(profileId, fragment, workspace, { visited: nextVisited })) return false;
      } catch { return false; }
    }
    if (keys.length) for (const row of host.database.origins(profileId, { entryKeys: keys })) ids.add(row.sessionId);
    for (const id of ids) {
      const session = this.chatSessionStore.listSessions().find(entry => entry.profileId === profileId && entry.id === id);
      if (!session || session.workspace !== workspace || host?.database.tombstones(profileId, [id]).length) return false;
    }
    return true;
  }
  allowResult(profileId, result, input) {
    if (!input || input.profileId !== profileId || hasSecret(result.snippet || "")) return false;
    this.assertProfile(profileId); this.recallPolicy.assertReady(profileId);
    if (result.source === "sessions") {
      try {
        const host = this.host(profileId), id = host.searchIndex.sessionIdForPath(result.path);
        const session = host.sessions.current(profileId, id);
        if (session.workspace !== input.workspace || !Number.isSafeInteger(result.startLine) || result.startLine < 1
          || !Number.isSafeInteger(result.endLine) || result.endLine < result.startLine) return false;
        return !this.recallPolicy.hasRevokedContent(profileId, result.snippet || "");
      } catch { return false; }
    }
    if (this.host(profileId).searchIndex.sourceFiles.isExtra(result.path)) {
      if (!this.sourceSessionsVisible(profileId, result.snippet || "", input.workspace)) return false;
      const metadata = core.extractCuratedEntryRecallMetadata({ sourceLines: (result.snippet || "").split("\n"),
        curatedRoot: false, projectScopeEligible: true });
      const projectKey = result.projectKey || metadata.projectKey;
      return !projectKey || projectKey.split("; ").every(key => workspaceMemoryRefs(input.workspace, "project").includes(key));
    }
    const overlaps = this.store.list(profileId, { status: "active" }).filter(item => item.memoryPath === result.path
      && item.startLine <= result.endLine && item.endLine >= result.startLine);
    // Internal corpus lines carry original session identity; they are checked
    // above, and never become bootstrap memory merely by being indexed.
    if (!overlaps.length) return result.path.startsWith("memory/.dreams/session-corpus/")
      && /\/sessions\//u.test(result.snippet || "") && this.sourceSessionsVisible(profileId, result.snippet || "", input.workspace);
    // Search chunks may omit their promotion marker. The overlapping complete
    // file entries retain its authority; a truncated display snippet does not.
    return overlaps.every(item => this.visible(item, input));
  }
  search(input) {
    this.assertProfile(input.profileId); this.recallPolicy.assertReady(input.profileId);
    if (input.query?.trim()) fail("MEMORY_SEARCH_ASYNC_REQUIRED", "文件记忆检索需要异步索引入口");
    let bytes = 0; const limit = input.limit ?? 100, maxBytes = input.maxBytes ?? 128 * 1024;
    const all = this.store.list(input.profileId, { status: "active" }).filter(item => this.visible(item, input));
    const items = all.filter(item => { const size = Buffer.byteLength(item.content); if (bytes + size > maxBytes) return false; bytes += size; return true; }).slice(0, limit);
    return { items, revision: this.store.getRevision(input.profileId), truncated: items.length < all.length };
  }
  searchMemory(input) {
    const deadlineAt = performance.now() + 30_000;
    return this.sharing.withRequest(input, async scoped => {
      const policy = this.sharing.policy(scoped);
      const own = await this.searchOwnMemory(policy.enabled && scoped.memoryScope !== "own" ? { ...scoped, record: false } : scoped);
      return this.sharing.search({ ...scoped, deadlineAt }, own);
    });
  }
  async searchOwnMemory(input) {
    this.assertProfile(input.profileId); this.recallPolicy.assertReady(input.profileId);
    const host = this.host(input.profileId), stamp = this.semanticStamp(input.profileId);
    let results;
    try {
      results = await this.searchScope.run(input, () => host.searchIndex.search(input.query, {
        maxResults: input.maxResults ?? input.limit, minScore: input.minScore, sources: input.sources, lexicalOnly: input.lexicalOnly === true,
        activeProjectKeys: workspaceMemoryRefs(input.workspace, "project"), signal: input.signal, record: input.record !== false && !this.sharing.borrowedRefsForRun(input.run?.id).length }));
    } catch (error) {
      input.signal?.throwIfAborted();
      // Native cache admission now notices source withdrawal before publication.
      // Preserve the public conflict contract for that earlier rejection.
      if (["MEMORY_SESSION_CHANGED", "MEMORY_SESSION_REVOKED"].includes(error.code)
        && stamp !== this.semanticStamp(input.profileId)) fail("MEMORY_REVISION_CONFLICT", "检索期间记忆或权限已变化");
      throw error;
    }
    if (stamp !== this.semanticStamp(input.profileId)) fail("MEMORY_REVISION_CONFLICT", "检索期间记忆或权限已变化");
    const active = this.store.list(input.profileId, { status: "active" }), items = [], seen = new Set();
    let bytes = 0;
    for (const result of results) for (const item of active) {
      if (seen.has(item.id) || item.memoryPath !== result.path || item.startLine > result.endLine || item.endLine < result.startLine || !this.visible(item, input)) continue;
      bytes += Buffer.byteLength(item.content); if (bytes > (input.maxBytes ?? 24 * 1024)) break;
      seen.add(item.id); items.push({ ...item, score: result.score, citation: result.citation });
    }
    return { items, results, revision: this.store.getRevision(input.profileId), truncated: false,
      semantic: { status: host.searchIndex.embeddingFailure ? "fallback" : "ready", modelId: host.searchIndex.model } };
  }
  getFile(input) {
    if (this.sharing.recognizes(input.path)) return this.sharing.get(input);
    this.assertProfile(input.profileId); this.recallPolicy.assertReady(input.profileId);
    const relative = input.path;
    const host = this.host(input.profileId), source = host.searchIndex.readSource(relative), content = source.text;
    const from = input.from ?? 1, count = input.lines ?? 200, lines = content.split("\n");
    if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(count) || count < 1 || count > 200) fail("MEMORY_INVALID", "行范围无效");
    const endLine = Math.min(from + count - 1, lines.length), text = lines.slice(from - 1, endLine).join("\n");
    const result = { path: relative, startLine: from, endLine, snippet: text };
    if (text && source.kind === "extra") {
      // A caller cannot remove a project annotation by requesting only the
      // continuation lines. Reuse the same full-source chunks as search.
      const keys = host.searchIndex.prepareSourceChunks(relative, "memory", source)
        .filter(chunk => chunk.startLine <= endLine && chunk.endLine >= from).map(chunk => chunk.projectKey).filter(Boolean);
      if (keys.length) result.projectKey = [...new Set(keys)].join("; ");
    }
    if (text && !this.allowResult(input.profileId, result, input)) fail("MEMORY_NOT_FOUND", "记忆文件的内容不再可见");
    if (Buffer.byteLength(text) > 24 * 1024) fail("MEMORY_RANGE_TOO_LARGE", "请缩小记忆读取行数");
    const items = this.store.list(input.profileId, { status: "active" }).filter(item => item.memoryPath === relative
      && item.startLine <= endLine && item.endLine >= from && this.visible(item, input));
    return { path: relative, text, from, lines: Math.max(0, endLine - from + 1), totalLines: lines.length,
      items, revision: this.store.getRevision(input.profileId), viewStatus: this.viewStatus(input.profileId) };
  }
  bootstrap(input) {
    this.assertProfile(input.profileId); this.recallPolicy.assertReady(input.profileId);
    // Core memory belongs to the private main conversation. Background runs
    // still receive their permitted user profile and current daily notes.
    const config = core.resolveMemoryDeepDreamingConfig({ cfg: this.config(input.profileId),
      pluginConfig: core.resolveMemoryDreamingPluginConfig(this.config(input.profileId)) });
    const days = [this.now(), this.now() - 86400_000].map(time => core.formatMemoryDreamingDay(time, config.timezone));
    const files = ["USER.md", ...(input.mainSession ? ["MEMORY.md"] : []), ...[...new Set(days)].map(day => `memory/${day}.md`)];
    const all = this.store.list(input.profileId, { status: "active" }), source = [];
    for (const relative of files) {
      const contents = this.store.readFile(input.profileId, relative);
      const entries = all.filter(item => item.memoryPath === relative), allowed = entries.filter(item => this.visible(item, input));
      const allowedIds = new Set(allowed.map(item => item.id));
      const text = contents.split("\n").filter((_line, index) => entries.filter(item => item.startLine <= index + 1 && item.endLine >= index + 1)
        .every(item => allowedIds.has(item.id))).join("\n");
      if (hasSecret(text)) fail("MEMORY_SECRET_REJECTED", "核心记忆文件含有凭据，无法进入模型上下文");
      if (text.trim()) source.push({ path: relative, text, items: allowed });
    }
    return { user: source.filter(file => file.path === "USER.md"), memory: source.filter(file => file.path !== "USER.md"),
      revision: this.store.getRevision(input.profileId) };
  }
  // Every host and source check reads the roster. A workspace is fixed per
  // Profile id, so reuse the view while the shared read-only roster is unchanged.
  rosterView() {
    const profiles = this.profiles();
    if (this.roster?.profiles !== profiles) {
      this.roster = { profiles, value: Object.freeze(profiles.map(profile => Object.freeze({ id: profile.id, workspace: this.store.workspace(profile.id) }))) };
    }
    return this.roster.value;
  }
  sessionScopeStamp(profileId) {
    // Session authority is per Profile. A foreign chat's ordinary timestamp
    // update cannot revoke this Profile's in-flight reads or recall evidence.
    // The store caches the same digest per write; recall checks read it often.
    if (typeof this.chatSessionStore?.profileSessionsDigest === "function") return this.chatSessionStore.profileSessionsDigest(profileId);
    const sessions = this.chatSessionStore?.listSessions?.().filter(session => session.profileId === profileId)
      .sort((left, right) => left.id.localeCompare(right.id));
    return sha256(JSON.stringify(sessions || []));
  }
  semanticStamp(profileId) { return JSON.stringify([this.store.getRevision(profileId), this.recallPolicy.getRevision(profileId),
    this.transcriptStore?.getChangeRevision?.(profileId), this.sessionScopeStamp(profileId), this.config(profileId)]); }
  sourcePolicyStamp(profileId) { return JSON.stringify([this.recallPolicy.getRevision(profileId),
    this.transcriptStore?.getChangeRevision?.(profileId), this.sessionScopeStamp(profileId), this.profiles().find(profile => profile.id === profileId), this.config(profileId)]); }
  semanticDocuments() { return []; } // The upstream index owns memory embeddings.
  listShared() { return { items: [], truncated: false }; }
  findSharedItem() { return null; }
  findSharedDuplicate() { return null; }
  findPeerItem() { return null; }
  hasRevokedContentAnywhere(profileId, content) { return this.recallPolicy.hasRevokedContent(profileId, content); }

  assertOwnedMemorySources(input) {
    assertNoBorrowedMemoryWrite(input);
    const refs = new Set(input.sourceRefs || []);
    if ([...refs].some(ref => this.sharing.recognizes(ref)) || this.sharing.recognizes(input.supersedes)) fail("MEMORY_BORROWED_READ_ONLY", "借阅引用不能写入当前助理记忆");
    const referenced = [], runDerived = [], uiRuns = [];
    for (const session of this.chatSessionStore.listSessions().filter(session => session.profileId === input.profileId)) {
      for (const event of this.transcriptStore.listEvents(input.profileId, session.id)) {
        if (refs.has(event.id)) referenced.push(event);
        if (refs.has(event.runId) && isUiActionSubmission(event)) uiRuns.push(event);
        if (refs.has(event.runId) && isBorrowedMemoryDerived(event)) runDerived.push(event);
      }
    }
    if (referenced.some(isBorrowedMemoryDerived) || (!referenced.length && runDerived.length)) fail("MEMORY_BORROWED_READ_ONLY", "借阅派生内容不能保存为当前助理记忆");
    if (referenced.some(isUiActionSubmission) || (!referenced.length && uiRuns.length)) fail("MEMORY_SOURCE_REVOKED", "交互界面的自动提交不能作为用户独立事实保存");
    const borrowedRun = runDerived.length > 0 || [...refs].some(ref => this.sharing.borrowedRefsForRun(ref).length > 0);
    if (borrowedRun) {
      // A query mentioning the same topic is not evidence for a borrowed fact.
      // In a tainted run only the user's independently supplied complete words
      // authorize a write; a paraphrase cannot safely shed the source taint.
      const normalized = text => typeof text === "string" ? text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase() : "";
      const content = normalized(input.content);
      if (!content || !referenced.some(event => event.kind === "user" && !isBorrowedMemoryDerived(event)
        && normalized(event.content?.text).includes(content))) {
        fail("MEMORY_BORROWED_READ_ONLY", "本轮只能保存用户新消息中的原文事实，不能回存借阅内容");
      }
    }
  }
  async propose(input) {
    this.assertOwnedMemorySources(input);
    this.assertProfile(input.profileId); this.recallPolicy.assertReady(input.profileId);
    const revision = input.expectedRevision ?? this.store.getRevision(input.profileId), now = this.now();
    if (!["explicit", "imported", "inferred"].includes(input.classification) || typeof input.content !== "string" || !input.content.trim()) fail("MEMORY_INVALID", "记忆内容无效");
    if (hasSecret(input.content)) fail("MEMORY_SECRET_REJECTED", "记忆不能保存凭据");
    const check = () => {
      this.assertProfile(input.profileId);
      this.assertOwnedMemorySources(input);
      if (!this.recallPolicy.isSourceVisible(input.profileId, input.sourceRefs || [])
        || input.classification !== "explicit" && this.recallPolicy.hasRevokedContent(input.profileId, input.content)) fail("MEMORY_SOURCE_REVOKED", "来源已撤回");
    }; check();
    const item = validate({ id: input.id || this.randomUUID(), profileId: input.profileId, scope: input.scope,
      type: input.type || "semantic", content: input.content.trim(), sourceRefs: [...new Set(input.sourceRefs || [])],
      confidence: input.confidence ?? (input.classification === "explicit" ? 1 : 0.5),
      sensitivity: input.sensitivity || (hasPii(input.content) ? "private" : "normal"),
      status: (input.sourceRefs || []).some(ref => ref.startsWith("untrusted:")) ? "candidate" : "active",
      validFrom: input.validFrom ?? now, validUntil: input.validUntil ?? null, supersedes: input.supersedes ?? null,
      createdAt: now, updatedAt: now });
    if (item.sensitivity === "restricted") fail("MEMORY_RESTRICTED", "不可保存受限记忆");
    const all = this.store.list(input.profileId);
    const duplicate = all.find(old => old.status === "active" && old.scope === item.scope && old.type === item.type
      && old.sensitivity === item.sensitivity && old.validUntil === item.validUntil
      && contentHash(old.content) === contentHash(item.content)
      && JSON.stringify(old.sourceRefs.filter(ref => ref.startsWith("workspace:"))) === JSON.stringify(item.sourceRefs.filter(ref => ref.startsWith("workspace:")))
      && this.recallPolicy.isMemoryVisible(input.profileId, old));
    if (duplicate && !item.supersedes) return duplicate;
    const records = [item];
    if (item.supersedes) {
      const prior = all.find(old => old.id === item.supersedes);
      if (!prior || prior.status !== "active" || prior.scope !== item.scope || !this.recallPolicy.isMemoryVisible(input.profileId, prior)) fail("MEMORY_CONFLICT_INVALID", "替代的记忆已变化");
      records.push({ ...prior, status: "superseded", updatedAt: now });
    }
    return (await this.store.upsertMany(records, { expectedRevision: revision, assertCurrent: check }))[0];
  }
  async update(input) {
    const item = this.store.get(input.profileId, input.id);
    if (!item || item.status !== "active") fail("MEMORY_NOT_FOUND", "记忆不存在");
    return this.propose({ ...item, ...input, id: this.randomUUID(), classification: "explicit", supersedes: item.id,
      sourceRefs: input.sourceRef ? [input.sourceRef, ...item.sourceRefs.filter(ref => ref.startsWith("workspace:"))] : item.sourceRefs });
  }
  async importBatch({ profileId, items, expectedRevision }) {
    this.assertProfile(profileId);
    if (!Array.isArray(items) || items.length > 128) fail("MEMORY_INVALID", "导入批次无效");
    for (const item of items) this.assertOwnedMemorySources({ ...item, profileId });
    const now = this.now(), records = items.map(item => validate({ ...item, profileId, content: item.content.trim(),
      confidence: 0.5, sensitivity: hasPii(item.content) ? "private" : "normal", status: "active",
      validFrom: now, validUntil: null, supersedes: null, createdAt: now, updatedAt: now }));
    const check = () => { for (const item of records) if (hasSecret(item.content) || this.recallPolicy.hasRevokedContent(profileId, item.content)
      || !this.recallPolicy.isSourceVisible(profileId, item.sourceRefs)) fail("MEMORY_SOURCE_REVOKED", "导入内容不再可用"); };
    check(); return this.store.upsertMany(records, { expectedRevision, assertCurrent: check });
  }
  async delete(input) {
    this.assertProfile(input.profileId); this.recallPolicy.assertReady(input.profileId);
    const item = this.store.get(input.profileId, input.id); if (!item) return null;
    const all = this.store.list(input.profileId), ids = new Set([item.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const record of all) if (ids.has(record.id) && record.supersedes && !ids.has(record.supersedes)
        || record.supersedes && ids.has(record.supersedes) && !ids.has(record.id)) {
        ids.add(record.id); if (record.supersedes) ids.add(record.supersedes); changed = true;
      }
    }
    const lineage = all.filter(record => ids.has(record.id));
    this.recallPolicy.recordReason({ profileId: input.profileId, item, relatedItems: lineage.filter(record => record.id !== item.id),
      reason: input.reason || "user_deleted", revocationSourceRefs: input.revocationSourceRefs || [],
      ...(input.operationId ? { operationId: input.operationId } : {}) });
    await this.store.upsertMany(lineage.map(record => ({ ...record, status: "deleted", updatedAt: Math.max(record.updatedAt, this.now()) })));
    this.sharing.withdraw(input.profileId, lineage);
    await this.sharing.reconcileConfig();
    return this.store.get(input.profileId, item.id);
  }
  forgetEverywhere(input) { return this.delete(input); }
  async forgetSources({ profileId, sourceRefs, reason, operationId }) {
    const refs = new Set(sourceRefs), matches = this.store.list(profileId).filter(item => item.sourceRefs.some(ref => refs.has(ref)));
    for (const item of matches) await this.delete({ profileId, id: item.id, reason, operationId: `${operationId}-${sha256(item.id).slice(0, 12)}` });
    return matches.length;
  }
  async forgetSession(profileId, sessionId) {
    const host = this.host(profileId); host.searchIndex.open();
    const report = await host.run(() => core.forgetMemoryEntries({ cfg: this.config(profileId), agentId: profileId, sessionIds: [sessionId] }));
    const refs = new Set(this.transcriptStore.listEvents(profileId, sessionId).flatMap(event => [event.id, event.runId]));
    const related = this.store.list(profileId, { status: "active" }).filter(item => item.sourceRefs.some(ref => refs.has(ref))
      || item.sourceEvidence?.some(source => source.sessionId === sessionId));
    for (const item of related) await this.delete({ profileId, id: item.id, reason: "forgotten", operationId: `session-forget-${sha256(`${sessionId}:${item.id}`)}` });
    await this.sharing.reconcileConfig();
    this.onLearningSourcesChanged?.(profileId);
    return report;
  }
  async undoConsolidation({ profileId, id, operationId }) {
    // A user-authored edit creates a new source; never resurrect the revoked source.
    const current = this.store.get(profileId, id), prior = current?.supersedes && this.store.get(profileId, current.supersedes);
    const item = await this.delete({ profileId, id, operationId });
    const restored = prior ? await this.propose({ ...prior, id: this.randomUUID(), supersedes: null,
      classification: "explicit", sourceRefs: [`user-edit:${this.randomUUID()}`] }) : null;
    return { item, restored };
  }
  consolidate() { return { owner: this.owner }; }
  flushBeforeCompaction(input) { return this.maintenance.flush(input); }
  observeBeforeSend(input) { return this.maintenance.flush({ ...input, preflight: true }); }
  prepareActiveMemory(input) { return this.activeMemory.prepare(input); }
  takeActiveMemory(input) { return this.activeMemory.take(input); }
  async finishActiveMemoryRun(run) {
    this.sharing.endRun(run);
    return this.activeMemory.endRun(run);
  }
  config(profileId) {
    const raw = this.getConfig();
    const providerConfig = this.projectProviderMetadata ? this.projectProviderMetadata(profileId, raw) : raw;
    const cfg = require("../active-memory-defaults").projectActiveMemoryDefaults(providerConfig, this.profiles().map(profile => profile.id));
    const selected = cfg.agents?.entries?.[profileId] ?? cfg.agents?.list?.find(profile => profile.id === profileId) ?? {};
    return { ...cfg, agents: { ...cfg.agents, list: undefined,
      entries: { [profileId]: { ...selected, id: profileId, workspace: this.store.workspace(profileId) } } } };
  }
  dream(profileId, { signal } = {}) {
    if (this.jobs.has(profileId)) return this.jobs.get(profileId);
    signal = AbortSignal.any([this.maintenance.controller.signal, this.profileSignal(profileId), ...(signal ? [signal] : [])]);
    const host = this.host(profileId);
    const job = this.sourceAuthority.run({ profileId, stamp: this.sourcePolicyStamp(profileId) }, () => host.runWithSourceEvidence(async () => {
      signal?.throwIfAborted();
      await host.pruneUnavailableLibraryCandidates();
      const cfg = this.config(profileId), config = core.resolveMemoryDeepDreamingConfig({ cfg, pluginConfig: core.resolveMemoryDreamingPluginConfig(cfg) });
      const result = await core.runShortTermDreamingPromotion({ trigger: "heartbeat", agentId: profileId, workspaceDir: host.workspaceDir,
        cfg, config, logger: this.logger, subagent: this.complete ? { complete: request => host.runWithDreamingCompletionSourceEvidence(request, async () => {
          signal?.throwIfAborted(); host.rememberPromotionSources(request.message); host.assertFileSources();
          const result = await this.complete({ profileId, prompt: `${request.extraSystemPrompt || ""}\n\n${request.message}`,
            model: request.model, timeoutMs: request.timeoutMs, signal,
            assertCurrent: () => { signal.throwIfAborted(); host.assertFileSources(); } });
          signal?.throwIfAborted(); host.assertFileSources(); return result;
        }) } : undefined });
      signal?.throwIfAborted(); host.assertFileSources();
      // Proof belongs to the exact output of one phase, never every file
      // touched by a sweep. Unknown inputs and prior diary paragraphs remain
      // unshared even when another phase has valid promotion candidates.
      for (const proof of host.phaseEvidenceSnapshot()) {
        if (proof.unresolved || !proof.sources.length) continue;
        try {
          this.store.registerReportEvidence(profileId, { path: proof.path, startLine: proof.startLine,
            endLine: proof.endLine, rangeHash: proof.rangeHash, sources: proof.sources });
        } catch (error) {
          if (!["MEMORY_REPORT_EVIDENCE_INVALID", "MEMORY_SOURCE_CHANGED"].includes(error.code)) throw error;
          // Sharing receipts are an additional publication boundary. An
          // oversized or already edited output gets no new sharing authority;
          // it does not undo a successful owner-only native sweep.
          this.logger.warn?.(`shoggoth-memory: shared report proof withheld [code=${error.code},phase=${proof.phase}]`);
        }
      }
      return result;
    }));
    this.jobs.set(profileId, job);
    void job.finally(() => { if (this.jobs.get(profileId) === job) this.jobs.delete(profileId); }).catch(() => {});
    return job;
  }
}

module.exports = { ShoggothMemoryService };
