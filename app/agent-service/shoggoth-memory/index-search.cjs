"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { core } = require("./host.cjs");

// The native inheritance chain owns search, provider acquisition/retirement,
// probe caching, identity repair and ranking. Product owns resource admission.
class MemoryIndexSearch extends core.MemorySearchOrchestration {
  constructor(index, stamp, { registry = index.registry, cacheKey = stamp } = {}) {
    super();
    this.index = index;
    this.executor = index.embeddingExecutor;
    this.stamp = stamp;
    this.agentId = index.agentId;
    this.workspaceDir = index.workspaceDir;
    this.cfg = index.getConfig();
    this.acquireLocalService = index.acquireLocalService;
    this.settings = index.settings;
    this.cache = this.settings.cache;
    this.publishedDatabase = this.executor.publishedDatabase;
    for (const source of this.settings.sources) this.sources.add(source);
    this.purpose = "default";
    this.providerRequirement = core.resolveMemoryEmbeddingProviderRequirement({ cfg: this.cfg, agentId: this.agentId, settings: this.settings });
    this.providerLifecycle = { mode: "pending", requestedProvider: this.settings.provider };
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    this.indexIdentityState = this.resolveCurrentIndexIdentityState({ providerKeyKnown: false });
    this.operations = new AsyncLocalStorage();
    this.memoryFiles = {
      assertCurrent: () => this.assertCurrent(),
      readFile: params => index.host.readMemoryFile(params),
      watch: (request, onChange, signal) => index.sourceFiles.watch(request, onChange, signal),
    };
    // One persistent manager owns native dirty state. The executor and shadow
    // resources do not install their own timers or Product subscriptions.
    for (const field of ["dirty", "memoryFullRetryDirty", "sessionsDirty", "sessionsFullRetryDirty", "sessionsReconcileDirty", "sessionsDirtyFiles"]) {
      Object.defineProperty(this, field, { configurable: true,
        get: () => this.executor[field], set: value => { this.executor[field] = value; } });
    }
    this.syncing = null;
    this.syncingMemoryWatchGeneration = 0;
    this.sessionReconcileGeneration = 0;
    this.syncingSessionReconcileGeneration = 0;
    this.sessionSyncQueue = new core.MemoryTargetedSessionSyncQueue({
      isClosed: () => this.closing || this.closed,
      getSyncing: () => this.syncing,
      sync: params => this.syncAdmitted(params, { queuedSessionOwner: true }),
    });
    this.registry = registry;
    this.cacheKey = cacheKey;
    this.embeddingProbeCache = this.registry.embeddingProbeCache;
    this.registry.track(this, this.cacheKey);
    this.createProvider = (adapter, create) => this.registry.createProvider(this, adapter, async () => {
      if (!this.index.usesNativeProvider(this.settings)) return create();
      this.assertCurrent();
      if (adapter.id === "local") this.index.assertLocalConfig(this.stamp);
      const result = await create();
      // A late result still belongs to this native Registry owner and its
      // retirement. Do not lose that resource by rejecting before registration.
      return { ...result, provider: result.provider ? this.executor.admitProvider(result.provider) : null };
    });
  }

  applyProviderResult(result) {
    super.applyProviderResult(result);
    if (this.index.usesNativeProvider(this.settings)) this.executor.attachProvider(this.provider, this.providerRuntime);
  }
  prepareLocalProvider() { return this.prepareNativeProvider(); }
  async prepareNativeProvider() {
    this.assertCurrent();
    if (this.settings.provider === "local") this.index.assertLocalConfig(this.stamp);
    try { await this.ensureProviderInitialized(); }
    catch (error) {
      this.assertCurrent();
      if (this.settings.provider === "local") this.index.assertLocalConfig(this.stamp);
      for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
        if (["MEMORY_REMOTE_PROVIDER_OWNER_INVALID", "MEMORY_REMOTE_PROVIDER_DESTINATION_MISMATCH", "MEMORY_REMOTE_PROVIDER_CHANGED"].includes(cause.code)) throw cause;
      }
      // The native bootstrap state owns availability caching and retry. A
      // configured local adapter retains the original optional-provider policy.
      this.markEmbeddingBootstrapFailure(error);
    }
    this.assertCurrent();
    this.executor.attachProvider(this.provider, this.providerRuntime);
    this.index.embeddingFailure = this.provider ? null : "MEMORY_EMBEDDING_UNAVAILABLE";
  }
  async activateFallbackProvider(reason) {
    try { return await super.activateFallbackProvider(reason); }
    finally {
      if (this.index.usesNativeProvider(this.settings) && !this.executor.closed) {
        this.executor.attachProvider(this.provider, this.providerRuntime);
        this.index.configurePublication(this.settings, this.stamp);
      }
    }
  }
  markLocalEmbeddingProviderDegraded(error) {
    super.markLocalEmbeddingProviderDegraded(error);
    if (this.index.usesNativeProvider(this.settings)) this.executor.attachProvider(this.provider, this.providerRuntime);
  }

  assertCurrent() {
    this.index.assertConfig(this.stamp);
    if (this.closed || this.publishedDatabase.closed || this.executor.closed) throw Object.assign(new Error("Memory search owner was retired"), { code: "MEMORY_SCOPE_REVOKED" });
  }
  releaseProvider(provider) { this.registry.releaseProvider(this, provider); }
  canPublishEmbeddingProbe() {
    if (this.closing || this.closed || this.executor.closed) return false;
    // Default replacement joins physical retirement without marking the
    // Registry's plugin-reload flag. A logically cancelled old probe must not
    // populate the shared cache while the replacement has an identical native
    // key (for example, a Product revision-only update).
    try { this.assertCurrent(); } catch { return false; }
    return this.registry.canPublishProbe(this);
  }
  getEmbeddingProbeOwners() { return this.registry.getProbeOwners(this); }
  async withManagerOperation(action) {
    this.assertCurrent();
    // Native background-context snapshots intentionally clear a caller's ALS.
    // Restore only this admitted Product resource owner at the entry boundary.
    return this.index.host.run(() => super.withManagerOperation(async () => {
      this.assertCurrent();
      const result = await action();
      this.assertCurrent();
      return result;
    }));
  }

  startBackground() {
    if (this.backgroundStarted || this.closing || this.closed) return;
    this.assertCurrent();
    core.runInMemoryBackgroundContext(() => this.index.host.run(() => {
      this.ensureWatcher();
      this.ensureSessionListener();
      this.ensureIntervalSync();
      this.ensureSessionStartupCatchup();
    }));
    this.backgroundStarted = true;
  }
  subscribeSessionTranscriptUpdates(listener) {
    return this.index.host.onInternalSessionTranscriptUpdate(update => core.runInMemoryBackgroundContext(() => {
      if (this.closing || this.closed) return;
      if (update.reconcile) {
        // Product policy and session lifecycle facts can withdraw an entire
        // source. A target-only native pass cannot remove absent corpus rows.
        this.sessionsReconcileDirty = true;
        this.sessionsFullRetryDirty = true;
        this.sessionsDirty = true;
        this.sessionReconcileGeneration++;
        void this.sync({ reason: "product-session-reconcile" }).catch(error => this.index.logger.warn?.(`memory session reconciliation failed: ${String(error)}`));
      } else listener(update);
    }));
  }
  async markSessionStartupCatchupDirtyFiles(inspectSources = false) {
    const files = await super.markSessionStartupCatchupDirtyFiles(inspectSources);
    if (this.index.host.sessions.requiresStartupContentRecheck && !this.startupContentRechecked) {
      // Product's durable journal sequence is not a mutation wall clock.
      // Admit each source once at startup; native content hashes suppress
      // unchanged publication and detect same-sequence backup/policy restores.
      const entries = await this.listSessionCorpusEntries();
      for (const entry of entries) this.sessionsDirtyFiles.add(entry.sessionFile);
      this.sessionsDirty ||= this.sessionsDirtyFiles.size > 0;
      this.startupContentRechecked = true;
    }
    return files;
  }
  async sync(params) {
    if (this.closing || this.closed) return;
    return this.withManagerOperation(() => core.hasTargetedSessionSyncParams(params) && this.sessionSyncQueue.hasPending
      ? this.sessionSyncQueue.enqueue(params) : this.syncAdmitted(params));
  }
  async syncAdmitted(params, { queuedSessionOwner = false } = {}) {
    this.assertCurrent();
    if (this.syncing) {
      if (core.hasTargetedSessionSyncParams(params)) {
        if (!queuedSessionOwner) return this.sessionSyncQueue.enqueue(params);
        await this.syncing.catch(() => {});
        if (this.closing || this.closed) return;
        return this.syncAdmitted(params, { queuedSessionOwner: true });
      }
      let joinedFailure;
      try { await this.syncing; } catch (error) { joinedFailure = error; }
      if (params?.reason === "watch" && this.dirty && !this.closing && !this.closed
        && this.memoryWatchGeneration > this.syncingMemoryWatchGeneration) return this.syncAdmitted(params);
      if (params?.reason === "product-session-reconcile" && !this.closing && !this.closed
        && this.sessionReconcileGeneration > this.syncingSessionReconcileGeneration) return this.syncAdmitted(params);
      if (joinedFailure) throw joinedFailure;
      return;
    }
    const requestSignal = this.operations.getStore()?.signal || this.index.lifetime.signal;
    // The logical caller can be queued behind an independent config pass.
    // Retirement must cancel that wait before awaitManagerIdle; its physical
    // queue entry still owns its later stale-admission check and is drained by
    // index.tail, while real provider work remains joined by executor.close.
    const signal = AbortSignal.any([requestSignal, this.executor.lifetime.signal]);
    const generation = this.memoryWatchGeneration;
    const sessionGeneration = this.sessionReconcileGeneration;
    this.syncingMemoryWatchGeneration = generation;
    this.syncingSessionReconcileGeneration = sessionGeneration;
    if (params?.reason === "product-session-reconcile") {
      this.sessionsDirty = this.sessionsFullRetryDirty = this.sessionsReconcileDirty = true;
    }
    this.syncing = this.syncOutcomes.track(() => this.index.sync({ signal, force: params?.force, nativeParams: params, owner: this }), true)
      .then(() => {
        this.assertCurrent();
        if (generation !== this.memoryWatchGeneration) this.dirty = true;
        if (sessionGeneration !== this.sessionReconcileGeneration) {
          this.sessionsDirty = this.sessionsFullRetryDirty = this.sessionsReconcileDirty = true;
        }
      }).finally(() => { this.syncing = null; });
    return this.syncing;
  }
  syncPublishedIndexInBackground(params) {
    // The native search owner tracks this real promise until it settles. A
    // caller's deadline must not cancel admitted background resource cleanup.
    return core.runInMemoryBackgroundContext(() => this.sync(params));
  }
  async search(query, options) {
    return this.operations.run({ signal: options?.signal }, () => core.withMemoryEmbeddingExecution({
      signal: options?.signal,
      assertCurrent: () => this.assertCurrent(),
    }, async () => {
      if (this.index.embeddingFailure && !this.embeddingBootstrapFailure) {
        try {
          await this.ensureProviderInitialized();
          this.markEmbeddingBootstrapFailure(Object.assign(new Error(this.index.embeddingFailure), { code: this.index.embeddingFailure }), { retainProvider: true });
        } catch (error) {
          if (this.providerRequirement.mode !== "optional") throw error;
          this.markEmbeddingBootstrapFailure(error);
        }
      }
      return super.search(query, options);
    }));
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.sessionSyncQueue.clear();
    const closing = (async () => {
      const errors = [];
      // This manager owns its executor's admitted calls. Withdraw admission
      // promptly, while both native provider retirement and replacement still
      // join the executor's actual physical work; the shared E5 service stays
      // under Service ownership.
      const executorClosing = this.executor.close();
      executorClosing.catch(() => {});
      await this.closeWatchResources().catch(error => errors.push(error));
      this.sessionPendingFiles.clear();
      this.sessionPendingTargets.clear();
      await this.awaitManagerIdle();
      await this.syncing?.catch(() => {});
      await this.sessionSyncQueue.pending?.catch(() => {});
      await Promise.allSettled([this.providerInitPromise, this.fallbackProviderInitPromise].filter(Boolean));
      const retirements = await this.drainPendingProviderRetirements();
      if (this.providersPendingRetirement.size) errors.push(...retirements);
      await executorClosing.catch(error => errors.push(error));
      if (errors.length) throw new AggregateError(errors, "Memory manager resources did not retire");
      this.closed = true;
      this.registry.deleteIfCurrent(this.cacheKey, this);
      this.index.searchOwners.delete(this);
      this.index.embeddingExecutors.delete(this.executor);
    })();
    this.closePromise = closing;
    closing.catch(() => { if (this.closePromise === closing) this.closePromise = null; });
    return closing;
  }
}

module.exports = { MemoryIndexSearch };
