"use strict";

const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { openDatabase, transaction } = require("../inspiration-database");
const { preparePrivateParent } = require("../private-file");
const { core } = require("./host.cjs");
const { MemorySourceFiles } = require("./source-files.cjs");
const { MemoryIndexEmbedding } = require("./index-embedding.cjs");
const { MemoryIndexRebuild } = require("./index-rebuild.cjs");
const { MemoryIndexSearch } = require("./index-search.cjs");

// The SQL schema and all retrieval/ranking policies come from the pinned core.
// This owner supplies a derived local index and the Product embedding service.
class MemorySearchIndex {
  constructor({ host, databasePath, sharedDatabase = false, embedding = null, embeddingRuntime, embeddingAdapterFactory, remoteEmbeddingResources, acquireLocalService, assertLocalEmbeddingConfig, runLocalEmbedding, getConfig = () => ({}), provenance = () => undefined, allow = () => true, logger = console,
    backgroundSync = typeof host.sessions?.subscribeChanges === "function" }) {
    this.host = host;
    this.agentId = host.profileId;
    this.workspaceDir = host.workspaceDir;
    this.databasePath = databasePath;
    this.sharedDatabase = sharedDatabase;
    this.embedding = embedding;
    this.embeddingRuntime = embeddingRuntime;
    this.embeddingAdapterFactory = embeddingAdapterFactory;
    this.remoteEmbeddingResources = remoteEmbeddingResources;
    this.acquireLocalService = acquireLocalService;
    this.assertLocalEmbeddingConfig = assertLocalEmbeddingConfig;
    this.runLocalEmbedding = runLocalEmbedding;
    this.embeddingExecutors = new Set();
    this.searchOwners = new Set();
    this.registry = new core.MemoryManagerRegistry();
    this.searches = new Set();
    this.mediaSnapshots = new Map();
    this.lifetime = new AbortController();
    this.closing = false;
    this.getConfig = getConfig;
    this.sourceFiles = new MemorySourceFiles(host, getConfig);
    this.provenanceFor = provenance;
    this.allow = allow;
    this.candidateScope = new AsyncLocalStorage();
    this.logger = logger;
    this.backgroundSync = backgroundSync;
    this.db = null;
    this.model = embedding?.identity || "fts-only";
    this.fts = { enabled: true, available: true };
    this.settings = { store: { databasePath, fts: { tokenizer: "unicode61" } } };
    this.memoryFiles = null;
    this.memorySourceProvenanceRepairPending = false;
    this.tail = Promise.resolve();
    this.embeddingFailure = null;
    this.embeddingDimensions = undefined;
    this.activeEmbedding = null;
    this.providerIdentities = [];
    if (host.coordinationClosing && (host.searchIndex?.db || host.coordinationDatabases?.size)) throw new Error("Previous memory index is still closing");
    host.coordinationClosing = false;
    host.searchIndex = this;
  }

  open() {
    if (this.db) return;
    this.host.assertWorkspace(this.workspaceDir);
    preparePrivateParent(this.databasePath, this.host.paths.trustedRoot);
    const db = this.sharedDatabase ? this.host.database.db : openDatabase(this.databasePath);
    try {
      const ftsSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(core.MEMORY_INDEX_FTS_TABLE)?.sql || "";
      this.admitSchema(db, /tokenize\s*=\s*['"]trigram case_sensitive 0['"]/iu.test(ftsSql) ? "trigram" : "unicode61");
      this.db = db;
    } catch (error) { if (!this.sharedDatabase) db.close(); throw error; }
  }
  admitSchema(db, tokenizer) {
    if (!["unicode61", "trigram"].includes(tokenizer)) throw new Error("Invalid memory tokenizer");
    db.exec(core.buildMemoryIndexStrictSchema({ embeddingCacheTable: core.MEMORY_EMBEDDING_CACHE_TABLE, includeEmbeddingCache: true }));
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path_source ON memory_index_chunks(path,source,start_line)");
    const tokenizeClause = tokenizer === "trigram" ? ", tokenize='trigram case_sensitive 0'" : ", tokenize='unicode61'";
    core.ensureMemoryChunkFtsSchema({ db, ftsTable: core.MEMORY_INDEX_FTS_TABLE, tokenizeClause });
    core.ensureMemoryPathFtsSchema({ db, tokenizeClause });
    db.exec("INSERT OR IGNORE INTO memory_index_state VALUES (1,0)");
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.host.coordinationClosing = true;
    this.lifetime.abort(Object.assign(new Error("Memory index closed"), { code: "MEMORY_EMBEDDING_CANCELLED" }));
    this.closePromise = (async () => {
      await this.tail.catch(() => {});
      await Promise.allSettled([...this.searches]);
      await this.registry.closeAll();
      await Promise.all([...this.searchOwners].map(owner => owner.close()));
      await Promise.all([...this.embeddingExecutors].map(executor => executor.close()));
      await require("./index-coordination.cjs").waitForMemoryCoordination(this.host);
      if (this.db) { if (!this.sharedDatabase) this.db.close(); this.db = null; }
    })();
    const closing = this.closePromise;
    closing.catch(() => { if (this.closePromise === closing) this.closePromise = null; });
    return this.closePromise;
  }
  async retireProviderOwner() {
    // Catalog publication has already fenced old credential bindings. Join
    // the native scoped close without acquiring or probing a new provider.
    await this.registry.closeForAgent({ agentId: this.agentId, purpose: "default" });
    if (!this.searchOwner || this.searchOwner.closed) {
      this.searchOwner = null;
      this.embeddingExecutor = null;
      this.activeEmbedding = null;
      this.embeddingFailure = null;
      this.mediaSnapshots.clear();
    }
  }
  withManagerOperation(action) { return this.host.run(action); }
  syncAdmitted() { return this.sync(); }
  buildSourceFilter(prefix, sources = this.settings.searchSources || ["memory"]) {
    if (sources.some(source => !["memory", "sessions"].includes(source))) throw new Error("Invalid memory search source");
    const column = prefix ? `${prefix}.source` : "source";
    return sources.length ? { sql: ` AND ${column} IN (${sources.map(() => "?").join(",")})`, params: sources } : { sql: " AND 0", params: [] };
  }

  withCandidateFilter(filter, action) {
    if (typeof filter !== "function" || typeof action !== "function") throw new TypeError("Invalid memory candidate filter");
    return this.candidateScope.run({ filter, admittedIds: null, admittedPaths: null }, action);
  }
  prepareCandidateAdmission() {
    const scope = this.candidateScope.getStore();
    if (!scope) return;
    const rows = this.db.prepare("SELECT id,path,source,start_line AS startLine,end_line AS endLine,text AS snippet FROM memory_index_chunks ORDER BY path,source,start_line,end_line,id").all();
    scope.admittedIds = new Set(); scope.admittedPaths = new Set();
    const first = new Set();
    for (const row of rows) {
      const key = `${row.source}:${row.path}`, isFirst = !first.has(key); first.add(key);
      if (!this.isCurrent(row)) continue;
      scope.admittedIds.add(row.id);
      if (isFirst) scope.admittedPaths.add(key);
    }
  }
  constrainSourceFilter(base, alias, kind = "chunk") {
    if (!this.candidateScope.getStore()) return base;
    const prefix = alias ? `${alias}.` : "";
    this.db.function("shoggoth_shared_chunk_allowed", id => Number(this.candidateScope.getStore()?.admittedIds?.has(id) === true));
    this.db.function("shoggoth_shared_path_allowed", (source, relative) => Number(this.candidateScope.getStore()?.admittedPaths?.has(`${source}:${relative}`) === true));
    return { sql: (base?.sql || "") + (kind === "path"
      ? ` AND shoggoth_shared_path_allowed(${prefix}source,${prefix}path)=1`
      : ` AND shoggoth_shared_chunk_allowed(${prefix}id)=1`), params: base?.params || [] };
  }

  readCuratedCandidates(read, limit, activeProjectKeys) {
    if (!this.candidateScope.getStore()) return read(this.db, limit, activeProjectKeys);
    this.constrainSourceFilter({ sql: "", params: [] }, "chunk");
    const database = this.db;
    const view = new Proxy(database, { get(target, key) {
      if (key === "prepare") return sql => target.prepare(sql.replace(/ where /iu, ' where shoggoth_shared_chunk_allowed("chunk"."id")=1 and '));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return read(view, limit, activeProjectKeys);
  }

  readSource(relative) {
    return this.sourceFiles.read(relative);
  }

  sessionPath(sessionId) {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sessionId)) throw new Error("Invalid Product session identity");
    return `sessions/${this.agentId}/${sessionId}.jsonl`;
  }
  sessionIdForPath(relative) {
    if (typeof relative !== "string") throw new Error("Invalid session source");
    const prefix = `sessions/${this.agentId}/`, id = relative.slice(prefix.length, -6);
    if (!relative.startsWith(prefix) || !relative.endsWith(".jsonl") || this.sessionPath(id) !== relative) throw new Error("Foreign session source");
    return id;
  }
  readIndexedSource(relative, source) {
    if (source === "memory") {
      const media = this.mediaSnapshots.get(relative);
      if (media) {
        if (!this.sourceFiles.snapshotCurrent(media, this.settings)) throw Object.assign(new Error("Memory source changed"), { code: "MEMORY_SOURCE_CHANGED" });
        return media;
      }
      const value = this.readSource(relative);
      return { ...value, hash: core.hashText(value.text) };
    }
    if (source !== "sessions") throw new Error("Invalid memory source kind");
    const value = this.host.sessions.read(this.agentId, this.sessionIdForPath(relative));
    return { ...value, hash: value.revisionMs === undefined ? value.hash : `sqlite:${value.revisionMs}:${value.hash}`,
      text: value.content, mtime: value.mtimeMs };
  }
  prepareSourceChunks(relative, sourceKind, source, options = {}) {
    const prepare = (content) => core.prepareMemoryIndexChunks({ entry: { path: relative, mtimeMs: source.mtime,
      ...(sourceKind === "sessions" ? { lineMap: source.lineMap, lineProvenance: source.lineProvenance } : {}) },
      source: sourceKind, content,
      pathClassification: { curatedRoot: /^(MEMORY|USER|memory)\.md$/.test(relative), originClass: "agent" },
      chunking: this.settings.chunking || { tokens: 400, overlap: 80 },
      ...(options.provider ? { provider: options.provider } : {}), hardMaxInputTokens: options.hardMaxInputTokens ?? 8192 }).chunks;
    if (sourceKind !== "memory" || !/^(DREAMS|dreams)\.md$/u.test(relative)) return prepare(source.text);
    // Keep the original path and native preparation/ranking metadata. Only
    // Root report entry boundaries are narrowed before native publication.
    return core.splitCuratedMarkdownEntries(source.text).flatMap(part => prepare(part.text).map(chunk => {
      const offset = part.startLine - 1;
      return { ...chunk, startLine: chunk.startLine + offset, endLine: chunk.endLine + offset,
        ...(chunk.entryStartLine !== undefined ? { entryStartLine: chunk.entryStartLine + offset } : {}),
        ...(chunk.entryEndLine !== undefined ? { entryEndLine: chunk.entryEndLine + offset } : {}) };
    }));
  }
  resolveSettings() {
    const cfg = this.getConfig();
    // E5 is a named Product adapter, not the upstream `local` GGUF plugin.
    // Keep the established offline default when no explicit provider is selected.
    const hostConfig = { ...cfg, memory: { ...cfg.memory, search: {
      provider: this.embedding ? "shoggoth-e5" : "none", ...cfg.memory?.search } } };
    const resolved = this.host.run(() => core.resolveMemorySearchConfig(hostConfig, this.agentId));
    if (resolved && (!Number.isSafeInteger(resolved.query.maxResults) || resolved.query.maxResults < 1
      || resolved.query.maxResults > 200 || !Number.isFinite(resolved.query.minScore))) throw new TypeError("Invalid configured memory search limits");
    if (resolved && resolved.provider !== "none" && !this.embeddingAdapter(resolved.provider, cfg)) {
      throw Object.assign(new Error("Memory embedding provider is not available"), { code: "MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE" });
    }
    return { resolved, stamp: this.configStamp(cfg) };
  }
  usesNativeProvider(settings = this.settings) {
    return Boolean(settings && !["none", "shoggoth-e5"].includes(settings.provider));
  }
  registeredEmbeddingAdapters() {
    return ["shoggoth-e5", "local", "openai", "gemini", "mistral", "voyage", "ollama", "openai-compatible"]
      .map(id => this.embeddingAdapter(id)).filter(Boolean);
  }
  embeddingAdapter(id, cfg = this.getConfig()) {
    if (id === "local") {
      if (typeof this.acquireLocalService !== "function" || typeof this.assertLocalEmbeddingConfig !== "function" || typeof this.runLocalEmbedding !== "function") return undefined;
      return this.localAdapter ||= { ...core.llamaCppEmbeddingProviderAdapter, create: async options => {
        const stamp = this.embeddingExecutor.stamp;
        this.assertLocalConfig(stamp);
        const result = await this.runLocalEmbedding({ agentId: this.agentId, options, signal: core.memoryEmbeddingExecutionSignal(), prepare: false },
          () => core.llamaCppEmbeddingProviderAdapter.create(options));
        if (!result.provider) return result;
        const provider = result.provider;
        const admitted = Object.create(Object.getPrototypeOf(provider), Object.getOwnPropertyDescriptors(provider));
        for (const method of ["embed", "embedBatch"]) Object.defineProperty(admitted, method, {
          configurable: true, enumerable: true, writable: true, value: (input, request) => {
            this.assertLocalConfig(stamp);
            return this.runLocalEmbedding({ agentId: this.agentId, options, signal: request?.signal, prepare: true }, () => provider[method](input, request));
          },
        });
        return { ...result, provider: admitted };
      } };
    }
    if (id !== "shoggoth-e5") {
      const adapters = {
        openai: core.openAiMemoryEmbeddingProviderAdapter,
        gemini: core.geminiMemoryEmbeddingProviderAdapter,
        mistral: core.mistralMemoryEmbeddingProviderAdapter,
        voyage: core.voyageMemoryEmbeddingProviderAdapter,
        ollama: core.ollamaMemoryEmbeddingProviderAdapter,
        "openai-compatible": core.openAICompatibleEmbeddingProviderAdapter,
      };
      // The fixed pure alias resolver runs only after exact adapter lookup.
      // It reads admitted Product metadata and never discovers global plugins.
      const adapter = adapters[id] || adapters[core.resolveConfiguredGenericEmbeddingProviderId(id, cfg)];
      if (!adapter) return undefined;
      if (this.remoteEmbeddingResources) return this.remoteEmbeddingResources.resolveAdapter({
        agentId: this.agentId, providerId: id, adapter,
      });
      return { ...adapter, create: async () => {
        throw Object.assign(new Error("Memory provider owner resources are not available"), { code: "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED" });
      } };
    }
    if (this.e5Adapter) return this.e5Adapter;
    const resource = {
      id, transport: "local", defaultModel: "intfloat/multilingual-e5-small",
      resolveIndexIdentity: () => ({ model: this.embedding?.identity || "intfloat/multilingual-e5-small",
        cacheKeyData: this.embeddingRuntime?.cacheKeyData, aliases: this.embeddingRuntime?.indexIdentityAliases }),
      create: async () => {
        const executor = this.embeddingExecutor;
        if (!executor?.provider) throw Object.assign(new Error("Product E5 embedding service is unavailable"), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
        executor.assertCurrent();
        let retired = false;
        const invoke = action => {
          if (retired) throw Object.assign(new Error("Memory provider handle is retired"), { code: "MEMORY_SCOPE_REVOKED" });
          executor.assertCurrent();
          return action();
        };
        return { provider: {
          id, model: executor.provider.model,
          embed: (text, options) => invoke(() => executor.provider.embed(text, options)),
          embedBatch: (inputs, options) => invoke(() => executor.provider.embedBatch(inputs, options)),
          // E5 belongs to the Service. This handle owns only its admitted calls;
          // retirement drains actual work without stopping the shared worker.
          close: async () => { retired = true; await Promise.allSettled([...executor.pending]); },
        }, runtime: executor.providerRuntime };
      },
    };
    // This trusted Node resource seam is for isolated provider ownership
    // fixtures, while local GGUF requires its managed resources above.
    const adapter = this.embeddingAdapterFactory ? this.embeddingAdapterFactory(resource) : resource;
    if (!adapter || adapter.id !== id || adapter.transport !== "local" || typeof adapter.create !== "function") {
      throw new TypeError("Invalid local memory embedding adapter resource");
    }
    return this.e5Adapter = adapter;
  }
  localIdentity(cfg = this.getConfig(), settings = this.settings) {
    return this.host.run(() => core.llamaCppEmbeddingProviderAdapter.resolveIndexIdentity({
      config: cfg, provider: "local", model: settings.model, fallback: "none", local: settings.local,
      ...(typeof settings.outputDimensionality === "number" ? { dimensions: settings.outputDimensionality } : {}),
    }));
  }
  assertLocalConfig(stamp) {
    this.assertConfig(stamp);
    if (typeof this.acquireLocalService !== "function" || typeof this.assertLocalEmbeddingConfig !== "function" || typeof this.runLocalEmbedding !== "function") {
      throw Object.assign(new Error("Managed local embedding resources are not available"), { code: "MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE" });
    }
    this.assertLocalEmbeddingConfig({ config: this.getConfig(), agentId: this.agentId,
      settings: this.settings, identity: this.localIdentity() });
  }
  nativeIdentity(settings = this.settings, cfg = this.getConfig()) {
    return this.host.run(() => core.resolveEmbeddingProviderIndexIdentity({ config: cfg,
      ...core.resolveMemoryPrimaryProviderRequest({ settings }),
    }));
  }
  configStamp(cfg = this.getConfig()) {
    return JSON.stringify([cfg, Boolean(this.embedding), this.embedding?.identity ?? null,
      this.embeddingRuntime?.cacheKeyData, this.embeddingRuntime?.indexIdentityAliases,
      this.remoteEmbeddingResources?.capture(this.agentId) ?? null]);
  }
  assertConfig(stamp) {
    this.lifetime.signal.throwIfAborted();
    this.host.assertCurrent();
    if (this.configStamp() !== stamp) throw Object.assign(new Error("Memory configuration changed during indexing"), { code: "MEMORY_CONFIG_CHANGED" });
  }

  sync({ signal, force = false, nativeParams, owner } = {}) {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const next = this.tail.catch(() => {}).then(() => {
      signal.throwIfAborted();
      return this.host.run(() => this.syncFiles(signal, force, nativeParams, owner));
    }).then(result => {
      if (this.backgroundSync && !this.closing) this.searchOwner?.startBackground();
      return result;
    });
    this.tail = next;
    // Abort the caller promptly while the admitted operation still owns its
    // shadow and published connections until physical provider work drains.
    let removeAbort;
    const cancelled = new Promise((_, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    });
    return Promise.race([next, cancelled]).finally(removeAbort);
  }

  async syncFiles(signal, force = false, nativeParams, owner) {
    this.open();
    const { resolved, stamp } = this.resolveSettings();
    this.settings = { ...this.settings, ...(resolved || { provider: "none", cache: { enabled: false },
      chunking: { tokens: 400, overlap: 80 }, multimodal: { enabled: false, modalities: [], maxFileBytes: 10 * 1024 * 1024 } }), enabled: Boolean(resolved),
      sources: resolved?.sources || [], searchSources: resolved?.searchSources || [] };
    // A retired background caller cannot acquire a replacement while its own
    // active manager operation is waiting for this sync; that would close and
    // then wait on itself. The Service's independent config notification owns
    // fresh acquisition and publication for the new configuration.
    owner?.assertCurrent();
    await this.configureIndex(resolved, stamp);
    this.assertConfig(stamp);
    if (!resolved) return;
    if (this.usesNativeProvider(resolved)) {
      await core.withMemoryEmbeddingExecution({ signal: AbortSignal.any([signal, this.embeddingExecutor.lifetime.signal]),
        assertCurrent: () => this.assertConfig(stamp) }, () => this.searchOwner.prepareNativeProvider());
      this.configurePublication(resolved, stamp);
    }
    owner?.assertCurrent();
    if (nativeParams?.reason === "watch") this.embeddingExecutor.dirty = true;
    if (["product-session-reconcile", "session-startup-catchup"].includes(nativeParams?.reason)) {
      // A foreground freshness pass may have consumed flags while this
      // background request waited in the Product queue. Restore its admitted
      // withdrawal fact at physical execution, after that older pass finishes.
      this.embeddingExecutor.sessionsDirty = this.embeddingExecutor.sessionsFullRetryDirty
        = this.embeddingExecutor.sessionsReconcileDirty = true;
    }
    const targeted = core.hasTargetedSessionSyncParams(nativeParams);
    if (force && !targeted || this.needsRebuild || this.rebuildRetryState?.memoryFullRetryDirty || this.rebuildRetryState?.sessionsFullRetryDirty) {
      if (this.settings.provider !== "none" && !this.activeEmbedding
        && this.db.prepare("SELECT 1 FROM memory_index_chunks WHERE model<>'fts-only' LIMIT 1").get()) {
        if (this.usesNativeProvider(resolved)) this.searchOwner.resetProviderInitializationForRetry();
        throw Object.assign(new Error("Configured memory embedding provider is unavailable; existing vectors are retained"), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
      }
      try { await new MemoryIndexRebuild(this, [], stamp, signal).run(nativeParams); }
      catch (error) {
        signal?.throwIfAborted(); this.assertConfig(stamp);
        // Retain existing semantic generations. Fresh and already-keyword-only
        // indexes can remain available while the embedding provider recovers.
        if (this.db.prepare("SELECT 1 FROM memory_index_chunks WHERE model<>'fts-only' LIMIT 1").get()
          || !/^E5_[A-Z0-9_]+$/.test(error.code || "") && !["MEMORY_EMBEDDING_INVALID", "MEMORY_EMBEDDING_UNAVAILABLE", "MEMORY_EMBEDDING_OPERATION_FAILED"].includes(error.code)) {
          if (error.code === "MEMORY_EMBEDDING_OPERATION_FAILED") throw Object.assign(new Error("Memory embedding provider is unavailable"), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
          throw error;
        }
        if (error.code === "MEMORY_EMBEDDING_OPERATION_FAILED") throw Object.assign(new Error("Memory embedding provider is unavailable"), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
        this.embeddingFailure = error.code;
        await new MemoryIndexRebuild(this, [], stamp, signal, { forceFtsOnly: true }).run(nativeParams);
      }
      return;
    }
    if (this.usesNativeProvider(resolved)) {
      try { await new MemoryIndexRebuild(this, [], stamp, signal).run(nativeParams, { force: false, freshness: !owner }); }
      catch (error) {
        signal?.throwIfAborted(); this.assertConfig(stamp);
        if (error.code === "MEMORY_EMBEDDING_OPERATION_FAILED") throw Object.assign(new Error("Memory embedding provider is unavailable"), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
        throw error;
      }
      return;
    }
    const sourceOptions = { params: nativeParams, freshness: !owner,
      progress: nativeParams?.progress ? this.embeddingExecutor.createSyncProgress(nativeParams.progress) : undefined,
      shouldSyncMemory: !owner || owner.dirty || nativeParams?.reason === "search-bootstrap",
      shouldSyncSessions: !owner || owner.shouldSyncSessions(nativeParams, false) };
    try { await this.embeddingExecutor.syncSources(signal, sourceOptions); }
    catch (error) {
      signal?.throwIfAborted(); this.assertConfig(stamp);
      if (!/^E5_[A-Z0-9_]+$/.test(error.code || "")
        && !["MEMORY_EMBEDDING_INVALID", "MEMORY_EMBEDDING_UNAVAILABLE", "MEMORY_EMBEDDING_OPERATION_FAILED"].includes(error.code)) throw error;
      if (error.code === "MEMORY_EMBEDDING_OPERATION_FAILED") error = Object.assign(new Error("Memory embedding provider is unavailable"), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
      this.embeddingFailure = error.code;
      if (this.usesNativeProvider(resolved) && this.db.prepare("SELECT 1 FROM memory_index_chunks WHERE model<>'fts-only' LIMIT 1").get()) {
        this.searchOwner.resetProviderInitializationForRetry();
        throw error;
      }
      // Native source state skips successes already published by this pass.
      await this.embeddingExecutor.syncSources(signal, { ...sourceOptions, forceFtsOnly: true });
    }
  }

  validEmbedding(value) {
    return Array.isArray(value) && value.length <= 16_384 && core.isValidMemoryEmbedding(value, this.embeddingDimensions);
  }

  async configureIndex(resolved, stamp) {
    this.assertConfig(stamp);
    if (!resolved) {
      // Upstream disables acquisition when the resolver returns null. Drain
      // the existing native scope and retain its derived data for re-enabling;
      // disabled policy does not construct even a providerless manager.
      await this.registry.closeForAgent({ agentId: this.agentId, purpose: "default" });
      this.assertConfig(stamp);
      this.searchOwner = null;
      this.embeddingExecutor = null;
      this.activeEmbedding = null;
      this.embeddingFailure = null;
      this.mediaSnapshots.clear();
      return;
    }
    const tokenizer = resolved?.store.fts.tokenizer || "unicode61";
    if (!["unicode61", "trigram"].includes(tokenizer)) throw new Error("Invalid memory tokenizer");
    this.settings.store = { ...this.settings.store, databasePath: this.databasePath, fts: { tokenizer } };
    const providerRequirement = core.resolveMemoryEmbeddingProviderRequirement({ cfg: this.getConfig(), agentId: this.agentId, settings: this.settings });
    const cacheKey = core.resolveMemoryIndexManagerCacheKey({ agentId: this.agentId, workspaceDir: this.workspaceDir,
      settings: this.settings, providerRequirement, purpose: "default", acquireLocalService: this.acquireLocalService });
    const searchOwner = await this.registry.acquire({ agentId: this.agentId, purpose: "default" }, {
      prepare: () => {
        this.assertConfig(stamp);
        return { key: cacheKey,
          reuse: current => current.stamp === stamp && !current.closing && !current.closed && !current.executor.closed,
          create: async () => {
            // Native acquisition joins the old scope's physical retirement
            // before this callback can install any replacement resource.
            this.assertConfig(stamp);
            this.configurePublication(resolved, stamp);
            this.mediaSnapshots.clear();
            const embedding = resolved.provider === "shoggoth-e5" ? this.activeEmbedding : null;
            const executor = new MemoryIndexEmbedding(this, { stamp, runtime: embedding ? this.embeddingRuntime : undefined,
              provider: embedding ? { id: "shoggoth-e5", model: this.model,
                embed: (text, options) => embedding.encode(text, "query", options),
                embedBatch: async (inputs, options) => {
                  const vectors = [];
                  for (const input of inputs) {
                    options?.signal?.throwIfAborted(); this.assertConfig(stamp); core.assertMemoryEmbeddingRequestCurrent();
                    vectors.push(await embedding.encode(input, "passage", options));
                  }
                  return vectors;
                } } : null });
            this.embeddingExecutor = executor;
            this.embeddingExecutors.add(executor);
            try {
              const current = new MemoryIndexSearch(this, stamp, { registry: this.registry, cacheKey });
              this.searchOwners.add(current);
              return current;
            } catch (error) {
              await executor.close();
              this.embeddingExecutors.delete(executor);
              if (this.embeddingExecutor === executor) this.embeddingExecutor = null;
              throw error;
            }
          } };
      },
    });
    this.assertConfig(stamp);
    this.searchOwner = searchOwner;
    this.embeddingExecutor = searchOwner.executor;
    // Publication identity must be inspected on every pass, including native
    // manager reuse after a rebuild changed the published metadata.
    this.configurePublication(resolved, stamp);
  }

  configurePublication(resolved, stamp) {
    this.assertConfig(stamp);
    const native = this.usesNativeProvider(resolved), configuredIdentity = native ? this.nativeIdentity(resolved) : null;
    const nativeExecutor = native && this.embeddingExecutor?.stamp === stamp && !this.embeddingExecutor.closed ? this.embeddingExecutor : null;
    this.activeEmbedding = native ? nativeExecutor?.provider || null : resolved?.provider === "shoggoth-e5" ? this.embedding : null;
    const provider = native ? nativeExecutor?.provider || configuredIdentity?.provider || { id: resolved.provider, model: resolved.model }
      : this.activeEmbedding ? { id: resolved.provider, model: this.activeEmbedding.identity } : null;
    this.model = provider?.model || "fts-only";
    if (!native) this.embeddingFailure = resolved?.provider === "shoggoth-e5" && !this.activeEmbedding ? "MEMORY_EMBEDDING_UNAVAILABLE" : null;
    const runtime = native ? nativeExecutor?.providerRuntime : this.activeEmbedding ? this.embeddingRuntime : null;
    this.providerIdentities = core.resolveMemoryIndexProviderIdentities({ provider,
      cacheKeyData: runtime?.cacheKeyData || configuredIdentity?.cacheKeyData,
      aliases: runtime?.indexIdentityAliases || configuredIdentity?.aliases });
    const identity = JSON.stringify(this.providerIdentities);
    const tokenizer = resolved?.store.fts.tokenizer || "unicode61";
    if (!["unicode61", "trigram"].includes(tokenizer)) throw new Error("Invalid memory tokenizer");
    const previous = this.db.prepare("SELECT value FROM memory_index_meta WHERE key='shoggoth-provider-identity'").get()?.value;
    this.publicationIdentity = identity;
    this.publicationPolicy = JSON.stringify([this.settings.sources, this.settings.chunking, resolved?.extraPaths || [], this.settings.multimodal, tokenizer]);
    const indexIdentity = core.resolveMemoryIndexIdentityState({
      meta: core.readMemoryIndexMetadata(this.db).meta,
      provider: provider ? { id: provider.id, model: provider.model } : null,
      providerKey: this.providerIdentities[0].providerKey, providerAliases: this.providerIdentities.slice(1),
      configuredSources: core.resolveConfiguredSourcesForMeta(this.settings.sources),
      configuredScopeHash: core.resolveConfiguredScopeHash({ workspaceDir: this.workspaceDir,
        extraPaths: resolved?.extraPaths, multimodal: this.settings.multimodal }),
      chunkTokens: this.settings.chunking.tokens, chunkOverlap: this.settings.chunking.overlap,
      vectorReady: false, hasIndexedChunks: Boolean(this.db.prepare("SELECT 1 FROM memory_index_chunks LIMIT 1").get()),
      ftsTokenizer: tokenizer,
    });
    this.needsRebuild = this.db.prepare("SELECT value FROM memory_index_meta WHERE key='shoggoth-index-format'").get()?.value !== "5"
      || indexIdentity.status !== "valid"
      || Boolean(this.db.prepare("SELECT 1 FROM memory_index_sources WHERE path IN ('DREAMS.md','dreams.md') LIMIT 1").get())
        && this.db.prepare("SELECT value FROM memory_index_meta WHERE key='shoggoth-root-report-policy'").get()?.value !== "1";
    const dimensions = Number(this.db.prepare("SELECT value FROM memory_index_meta WHERE key='shoggoth-vector-dimensions'").get()?.value);
    this.embeddingDimensions = previous === identity && Number.isSafeInteger(dimensions) && dimensions > 0 && dimensions <= 16_384 ? dimensions : undefined;
    this.settings.store = { ...this.settings.store, databasePath: this.databasePath, fts: { tokenizer } };
  }

  writePublicationMetadata(dimensions) {
    const write = this.db.prepare("INSERT OR REPLACE INTO memory_index_meta VALUES (?,?)");
    write.run("shoggoth-index-format", "5");
    write.run("shoggoth-root-report-policy", "1");
    write.run("shoggoth-provider-identity", this.publicationIdentity);
    write.run("shoggoth-index-policy", this.publicationPolicy);
    if (dimensions) write.run("shoggoth-vector-dimensions", String(dimensions));
    else this.db.prepare("DELETE FROM memory_index_meta WHERE key='shoggoth-vector-dimensions'").run();
  }

  async keywordWorker(query, signal, includeIndexState = false) {
    signal?.throwIfAborted();
    const body = await core.searchKeyword({ ...query.body, sourceFilter: this.constrainSourceFilter(query.body.sourceFilter, undefined), db: this.db });
    const paths = await core.searchPathKeyword({ ...query.path, sourceFilter: this.constrainSourceFilter(query.path.sourceFilter, query.path.pathFtsTable, "path"), db: this.db });
    signal?.throwIfAborted(); this.host.assertCurrent();
    const admitted = new Set(this.admitCandidates([...body, ...paths]).map(result => result.id));
    return { kind: "keyword", body: { rows: body.filter(result => admitted.has(result.id)) }, path: { rows: paths.filter(result => admitted.has(result.id)) },
      ...(includeIndexState ? { indexState: core.readMemoryRetrievalIndexState(this.db) } : {}),
      ...(query.includeRecallMetadata ? { recallData: this.recallMetadata({ candidates: [...body, ...paths] }) } : {}) };
  }

  admitCandidates(candidates) {
    const metadata = this.recallMetadata({ candidates }).rows;
    return candidates.filter(result => {
      const projectKey = metadata.get(result.id)?.project_key;
      return this.isCurrent({ ...result, ...(typeof projectKey === "string" ? { projectKey } : {}) });
    });
  }

  recallMetadata({ candidates }) {
    const rows = new Map(), sourceMtimes = { memory: new Map(), sessions: new Map() };
    for (const candidate of candidates) {
      const row = this.db.prepare(`SELECT c.id,m.importance,m.triggers,m.project_key,p.origin_class,p.session_kind,p.observed_at,p.supersedes_key,s.mtime
        FROM memory_index_chunks c LEFT JOIN memory_index_chunk_recall_metadata m ON m.chunk_id=c.id
        LEFT JOIN memory_index_chunk_provenance p ON p.chunk_id=c.id
        LEFT JOIN memory_index_sources s ON s.path=c.path AND s.source=c.source WHERE c.id=?`).get(candidate.id);
      if (!row) continue;
      rows.set(candidate.id, { ...row, provenance: { originClass: row.origin_class, sessionKind: row.session_kind, observedAt: row.observed_at, ...(row.supersedes_key ? { supersedesKey: row.supersedes_key } : {}) } });
      sourceMtimes[candidate.source].set(candidate.path, row.mtime);
    }
    return { rows, sourceMtimes };
  }

  isCurrent(result) {
    this.host.assertCurrent();
    if (!["memory", "sessions"].includes(result.source) || this.candidateScope.getStore()?.filter(result) === false
      || !this.allow(result)) return false;
    const indexed = this.db.prepare("SELECT hash FROM memory_index_sources WHERE path=? AND source=?").get(result.path, result.source);
    try { return indexed?.hash === this.readIndexedSource(result.path, result.source).hash; }
    catch (error) { if (["ENOENT", "ENOTDIR", "MEMORY_PATH_NOT_ALLOWED", "MEMORY_SOURCE_CHANGED", "MEMORY_SESSION_REVOKED", "CONVERSATION_EVENT_NOT_FOUND"].includes(error.code)) return false; throw error; }
  }

  async listTriggerCandidates(options = {}) {
    options.signal?.throwIfAborted();
    await this.sync({ signal: options.signal });
    options.signal?.throwIfAborted();
    if (!this.settings.enabled || !this.searchOwner) return [];
    this.prepareCandidateAdmission();
    return this.host.run(async () => {
      const results = await this.searchOwner.listTriggerCandidates(options);
      options.signal?.throwIfAborted();
      return results.filter(result => this.isCurrent(result));
    });
  }

  async search(query, { maxResults, minScore, activeProjectKeys, signal, record = true, sources, lexicalOnly = false, sessionKey, onDebug, onPartialResults } = {}) {
    if (!query?.trim()) return [];
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    const { resolved, stamp } = this.resolveSettings();
    if (!resolved) { await this.sync({ signal }); return []; }
    maxResults ??= resolved.query.maxResults; minScore ??= resolved.query.minScore;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 200 || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new TypeError("Invalid memory search limits");
    // Product source discovery remains a foreground freshness barrier even
    // with native background change events. Native search owns retrieval
    // generations, provider recovery, identity repair and ranking.
    await this.sync({ signal });
    this.assertConfig(stamp);
    const owner = this.searchOwner;
    this.prepareCandidateAdmission();
    const operation = this.host.run(async () => {
      let results;
      try {
        results = await owner.search(query, { maxResults, minScore, activeProjectKeys, signal, sources, lexicalOnly, sessionKey, onDebug,
          onPartialResults: onPartialResults && (partial => onPartialResults(partial?.filter(result => this.isCurrent(result)) ?? null)),
        });
      } catch (error) {
        // Native embedding errors wrap transport failures. Product cancellation
        // keeps the original caller/lifetime reason at its public boundary.
        signal.throwIfAborted();
        this.assertConfig(stamp);
        throw error;
      }
      this.assertConfig(stamp);
      results = results.filter(result => this.isCurrent(result)).map(result => ({ ...result, citation: `${result.path}#L${result.startLine}-L${result.endLine}` }));
      // Native search has released its read lease before receipt mutations.
      if (record) {
        await this.host.pruneUnavailableLibraryCandidates();
        await core.recordShortTermRecalls({ workspaceDir: this.workspaceDir, query,
          results: results.filter(result => this.isCurrent(result)), nowMs: this.host.database.now() });
      }
      this.assertConfig(stamp);
      return results.filter(result => this.isCurrent(result));
    });
    this.searches.add(operation);
    try { return await operation; } finally { this.searches.delete(operation); }
  }

}

module.exports = { MemorySearchIndex };
