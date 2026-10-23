"use strict";

const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { transaction } = require("../inspiration-database");
const { core } = require("./host.cjs");

const failed = code => Object.assign(new Error(code), { code });

function safeEmbeddingError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (current.code === "MEMORY_EMBEDDING_INVALID" || current.message === "memory embeddings: malformed vector response (count, dimensions, or coordinates)") {
      return failed("MEMORY_EMBEDDING_INVALID");
    }
    if (/^E5_[A-Z0-9_]+$/.test(current.code || "")) return failed(current.code);
  }
  return failed("MEMORY_EMBEDDING_UNAVAILABLE");
}

// Resource bridge for the unmodified upstream embedding/cache classes. Product
// retains source authority and transactions; upstream chooses cache candidates,
// request groups, retries, timeout retry, failure counts and inline fallback.
class MemoryIndexEmbedding extends core.MemoryManagerEmbeddingOps {
  constructor(index, { provider, runtime, stamp, batch } = {}) {
    super();
    this.index = index;
    this.stamp = stamp;
    this.agentId = index.agentId;
    this.workspaceDir = index.workspaceDir;
    this.cfg = index.getConfig();
    this.settings = index.settings;
    this.cache = this.settings.cache;
    this.closed = false;
    this.lifetime = new AbortController();
    this.pending = new Set();
    this.sourceJobs = new AsyncLocalStorage();
    this.candidateScopes = new AsyncLocalStorage();
    this.databaseScopes = new AsyncLocalStorage();
    this.syncProviderGeneration = null;
    this.admittedProviders = new WeakMap();
    this.attachProvider(provider, runtime, batch);
    this.publishedDatabase = this.createDatabase(index.db);
    this.memoryFiles = {
      assertCurrent: () => this.assertCurrent(),
      listFiles: async workspace => {
        this.assertCurrent(); index.host.assertWorkspace(workspace);
        const files = await index.sourceFiles.list(this.settings);
        this.assertCurrent(); return files;
      },
      inspectFile: async absolute => {
        this.assertCurrent();
        const relative = path.relative(this.workspaceDir, absolute).replaceAll(path.sep, "/");
        try {
          const value = await index.sourceFiles.readForIndexing(relative, this.settings);
          this.assertCurrent();
          if (value?.kind === "multimodal") index.mediaSnapshots.set(relative, value);
          // Native discovery retains entries for the whole memory pass. Keep
          // content in the current preparation batch, not in discovery metadata.
          return value && value.kind !== "multimodal" ? { ...value, text: undefined } : value;
        }
        catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
      },
      readForIndexing: async absolute => {
        this.assertCurrent();
        const relative = path.relative(this.workspaceDir, absolute).replaceAll(path.sep, "/");
        const descriptor = this.sourceJobs.getStore()?.get(`memory:${relative}`);
        if (!descriptor) throw failed("MEMORY_SCOPE_REVOKED");
        if (!this.snapshotCurrent(descriptor)) return null;
        const source = index.sourceFiles.read(relative);
        if (core.hashText(source.text) !== descriptor.snapshot.hash) return null;
        return { content: source.text, canonicalRelativePath: relative };
      },
      buildMultimodalChunk: async entry => {
        this.assertCurrent();
        const descriptor = this.sourceJobs.getStore()?.get(`memory:${entry.path}`);
        if (!descriptor || entry.hash !== descriptor.snapshot.hash) throw failed("MEMORY_SCOPE_REVOKED");
        const chunk = await index.sourceFiles.buildMultimodalChunk(descriptor.snapshot, this.settings);
        this.assertCurrent(); return chunk;
      },
    };
  }

  admitProvider(provider) {
    if (this.admittedProviders.has(provider)) return this.admittedProviders.get(provider);
    let retired = false, closing;
    const pending = new Set();
    const assertHandle = () => { if (retired) throw failed("MEMORY_SCOPE_REVOKED"); };
    // Preserve the native runtime-facts symbol as well as ordinary provider
    // fields. Both query and source calls own the same physical-work wrapper.
    const admitted = Object.create(Object.getPrototypeOf(provider), Object.getOwnPropertyDescriptors(provider));
    Object.defineProperties(admitted, {
      embed: { configurable: true, enumerable: true, writable: true,
        value: (text, options) => {
          assertHandle();
          return this.providerCall(signal => { assertHandle(); return provider.embed(text, { ...options, signal }); }, options?.signal, pending);
        } },
      embedBatch: { configurable: true, enumerable: true, writable: true,
        value: (inputs, options) => {
          assertHandle();
          return this.providerCall(signal => { assertHandle(); return provider.embedBatch(inputs, { ...options, signal }); }, options?.signal, pending);
        } },
      close: { configurable: true, enumerable: true, writable: true, value: () => {
        retired = true;
        if (closing) return closing;
        const close = (async () => { await Promise.allSettled([...pending]); await provider.close?.(); })();
        closing = close;
        close.catch(() => { if (closing === close) closing = undefined; });
        return close;
      } },
    });
    this.admittedProviders.set(provider, admitted);
    this.admittedProviders.set(admitted, admitted);
    return admitted;
  }
  attachProvider(provider, runtime, batch) {
    this.provider = provider ? this.admitProvider(provider) : null;
    this.providerRuntime = runtime?.batchEmbed
      ? { ...runtime, batchEmbed: options => this.providerCall(() => runtime.batchEmbed(options)) } : runtime;
    const configured = batch || this.settings.remote?.batch;
    this.batch = { enabled: Boolean(configured?.enabled && runtime?.batchEmbed), wait: configured?.wait ?? true,
      concurrency: Math.max(1, configured?.concurrency ?? 2), pollIntervalMs: configured?.pollIntervalMs ?? 2000,
      timeoutMs: (configured?.timeoutMinutes ?? 60) * 60_000 };
  }

  get database() { return this.databaseScopes.getStore() || this.publishedDatabase; }
  get vector() { return this.database.vector; }
  get publication() { return this.database.publication; }

  createDatabase(db, { shadow = false } = {}) {
    const index = this.index;
    let closed = false;
    const assertResourceCurrent = () => {
      this.assertCurrent();
      if (resource.closed) throw failed("MEMORY_SCOPE_REVOKED");
      resource.assertShadowPath?.();
    };
    const resource = {
      db, hasIndex: true, readOnly: false, isShadow: shadow, pending: new Set(),
      vector: { enabled: false, available: false }, fts: shadow ? { ...index.fts } : index.fts,
      embeddingDimensions: index.embeddingDimensions,
      publishedSources: shadow ? new Map() : undefined,
      get closed() { return closed || !db.isOpen || !shadow && index.db !== db; },
      set closed(value) { closed = value; },
      withMutation: action => shadow ? action() : core.withMemoryIndexMutationGeneration(index.databasePath, () => {
        this.assertCurrent(); return action();
      }),
      withPrivateAccess: async action => {
        this.assertCurrent();
        if (resource.closed) throw failed("MEMORY_SCOPE_REVOKED");
        return action();
      },
      pruneEmbeddingCache: async (max, assertCurrent) => transaction(db, () => {
        this.assertCurrent(); assertCurrent();
        const before = db.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get().n;
        core.pruneMemoryEmbeddingCache(db, max);
        return before > max;
      }),
      readSourceState: async query => {
        assertResourceCurrent();
        const rows = core.loadMemorySourceFileState({ ...query, db });
        assertResourceCurrent();
        return rows;
      },
      read: async (request, assertCurrent) => {
        assertResourceCurrent(); assertCurrent();
        if (request.type === "source.hash") {
          return core.readMemorySourceHash(db, request.input.source, request.input.path);
        }
        if (request.type === "session.current") {
          if (request.input.agentId !== this.agentId) throw failed("MEMORY_SCOPE_REVOKED");
          const descriptor = this.sourceJobs.getStore()?.get(`sessions:${index.sessionPath(request.input.sessionId)}`);
          this.assertSnapshot(descriptor);
          return "current";
        }
        if (request.type !== "cache.read") throw new Error("Unsupported memory embedding cache read");
        const cached = core.loadMemoryEmbeddingCache({ db, ...request.input });
        for (const [hash, vector] of cached) if (vector.length > 16_384) cached.delete(hash);
        return cached;
      },
      deleteSource: async (input, assertCurrent) => {
        assertResourceCurrent(); assertCurrent();
        if (resource.readOnly) throw failed("MEMORY_SCOPE_REVOKED");
        const deleted = await resource.withMutation(() => transaction(db, () => {
          assertResourceCurrent(); assertCurrent();
          if (resource.readOnly) throw failed("MEMORY_SCOPE_REVOKED");
          const current = resource.publication.deleteIfCurrent(input);
          if (current) db.prepare("UPDATE memory_index_state SET revision=revision+1 WHERE id=1").run();
          assertResourceCurrent(); assertCurrent();
          return current;
        }));
        if (deleted) resource.publishedSources?.delete(`${input.source}:${input.path}`);
        return deleted;
      },
      refreshSourceState: async (input, assertCurrent) => {
        assertResourceCurrent(); assertCurrent();
        if (resource.readOnly) throw failed("MEMORY_SCOPE_REVOKED");
        return resource.withMutation(() => transaction(db, () => {
          assertResourceCurrent(); assertCurrent();
          if (resource.readOnly) throw failed("MEMORY_SCOPE_REVOKED");
          const refreshed = core.refreshMemorySessionSourceState(db, input);
          if (refreshed) db.prepare("UPDATE memory_index_state SET revision=revision+1 WHERE id=1").run();
          assertResourceCurrent(); assertCurrent();
          return refreshed;
        }));
      },
      mutateEmbeddingCache: async (mutation, assertCurrent, expectedRevision, invalidate) => {
        this.assertCurrent(); assertCurrent();
        const revision = expectedRevision();
        if (revision === undefined) return;
        // Upstream cache transactions do not take the source-mutation lease:
        // cache work can continue while a fused reader owns published rows.
        transaction(db, () => {
          this.assertCurrent(); assertCurrent();
          if (db.prepare("SELECT revision FROM memory_index_state WHERE id=1").get().revision !== revision) { invalidate(); return; }
          if (mutation.kind === "clear") core.clearMemoryEmbeddingCacheIdentities(db, mutation.identities);
          else if (mutation.kind === "upsert") {
            const candidates = this.candidateScopes.getStore();
            if (!candidates) throw failed("MEMORY_SCOPE_REVOKED");
            const valid = new Map();
            const entries = mutation.entries.filter(entry => (candidates.get(entry.hash) || []).some(candidate => {
              if (entry.sessionId !== (candidate.kind === "sessions" ? index.sessionIdForPath(candidate.relative) : undefined)) return false;
              if (!valid.has(candidate)) valid.set(candidate, this.snapshotCurrent(candidate));
              return valid.get(candidate);
            }));
            core.upsertMemoryEmbeddingCache({ db, ...mutation.header, now: index.host.database.now(), entries: () => entries });
          }
          else throw new Error("Unsupported memory embedding cache mutation");
        });
      },
      replaceSource: async (replacement, assertCurrent, prepare) => {
        this.assertCurrent(); assertCurrent();
        const descriptor = this.sourceJobs.getStore()?.get(`${replacement.source}:${replacement.entry.path}`);
        if (!descriptor || replacement.entry.hash !== descriptor.snapshot.hash) throw failed("MEMORY_SOURCE_CHANGED");
        if (!await prepare()) return null;
        this.assertCurrent(); assertCurrent();
        if (!this.snapshotCurrent(descriptor)) {
          if (descriptor.kind === "sessions") throw failed("MEMORY_SESSION_CHANGED");
          this.dirty = true; return null;
        }
        const result = await resource.withMutation(() => transaction(db, () => {
          this.assertCurrent(); assertCurrent();
          if (!this.snapshotCurrent(descriptor)) {
            if (descriptor.kind === "sessions") throw failed("MEMORY_SESSION_CHANGED");
            this.dirty = true; return null;
          }
          const beforeRevision = db.prepare("SELECT revision FROM memory_index_state WHERE id=1").get().revision;
          resource.publication.replaceRows(replacement, replacement.chunks.map((chunk, position) => ({ chunk, embedding: replacement.embeddings[position] || [] })));
          if (resource.embeddingDimensions) db.prepare("INSERT OR REPLACE INTO memory_index_meta VALUES ('shoggoth-vector-dimensions',?)").run(String(resource.embeddingDimensions));
          const databaseRevision = db.prepare("UPDATE memory_index_state SET revision=revision+1 WHERE id=1 RETURNING revision").get().revision;
          return { beforeRevision, databaseRevision };
        }));
        if (result) resource.publishedSources?.set(`${descriptor.kind}:${descriptor.relative}`,
          descriptor.kind === "sessions" ? { relative: descriptor.relative, kind: descriptor.kind,
            snapshot: { hash: descriptor.snapshot.hash, authorityStamp: descriptor.snapshot.authorityStamp } }
            : { ...descriptor, snapshot: { ...descriptor.snapshot, ...(descriptor.snapshot.kind !== "multimodal" ? { text: undefined } : {}) } });
        return result;
      },
    };
    // The original codec's materialized zero-length Uint8Array is bound as
    // SQL NULL by node:sqlite. Keep the native empty vector and normalize only
    // its driver representation; the canonical chunk/kernel algorithms stay
    // unchanged and SQLite receives the required zero-length BLOB.
    const publicationDatabase = {
      get isOpen() { return db.isOpen; },
      get isTransaction() { return db.isTransaction; },
      exec: sql => db.exec(sql),
      prepare: sql => {
        const statement = db.prepare(sql);
        return new Proxy(statement, { get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "run") return (...parameters) => target.run(...parameters.map(parameter => (
            parameter instanceof Uint8Array && parameter.byteLength === 0 ? Buffer.from(parameter) : parameter
          )));
          return typeof value === "function" ? value.bind(target) : value;
        } });
      },
    };
    resource.publication = new core.MemorySourceIndexKernel(publicationDatabase, resource);
    return resource;
  }

  managerEmbeddingError(error) {
    const safe = safeEmbeddingError(error);
    if (this.index.usesNativeProvider(this.settings) && error.code === "MEMORY_EMBEDDING_OPERATION_FAILED") {
      // Preserve the native failure classification until its fallback policy has
      // consumed it. Product public errors still discard provider response text.
      safe.code = "MEMORY_EMBEDDING_OPERATION_FAILED";
      safe.operation = error.operation;
      safe.providerId = error.providerId;
    }
    return safe;
  }
  assertCurrent() {
    if (this.closed) throw failed("MEMORY_EMBEDDING_CANCELLED");
    this.index.assertConfig(this.stamp);
    core.assertMemoryEmbeddingExecutionCurrent();
  }
  withPublishedDatabase(action) { this.assertCurrent(); return this.databaseScopes.exit(action); }
  markLocalEmbeddingProviderDegraded(error) {
    this.assertCurrent(); core.assertMemoryEmbeddingRequestCurrent(); this.lastFailure = safeEmbeddingError(error).code;
    if (this.settings.provider === "local") this.index.searchOwner?.markLocalEmbeddingProviderDegraded(error);
  }
  async runBatchWithTimeoutRetry(options) {
    const result = await super.runBatchWithTimeoutRetry(options);
    // Host withdrawal/cancellation must leave native provider-health accounting
    // untouched. The original timeout retry completes before this admission.
    this.assertCurrent();
    if (result.kind === "failure") core.assertMemoryEmbeddingRequestCurrent();
    return result;
  }

  async providerCall(action, originalSignal, handlePending) {
    this.assertCurrent();
    if (this.settings.provider === "local") this.index.assertLocalConfig(this.stamp);
    const database = this.database;
    const requestSignal = core.memoryEmbeddingExecutionSignal(originalSignal);
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.lifetime.signal]) : this.lifetime.signal;
    const pending = Promise.resolve().then(() => {
      this.assertCurrent(); core.assertMemoryEmbeddingRequestCurrent();
      if (this.settings.provider === "local") this.index.assertLocalConfig(this.stamp);
      return action(signal);
    });
    this.pending.add(pending);
    handlePending?.add(pending);
    database.pending.add(pending);
    const settled = () => { this.pending.delete(pending); handlePending?.delete(pending); database.pending.delete(pending); };
    pending.then(settled, settled);
    let removeAbort = () => {};
    try {
      const value = signal ? await Promise.race([pending, new Promise((_, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      })]) : await pending;
      this.assertCurrent();
      if (Array.isArray(value) && value.some(item => Array.isArray(item) && item.length > 16_384)) {
        throw failed("MEMORY_EMBEDDING_INVALID");
      }
      return value;
    } finally { removeAbort(); }
  }

  snapshotCurrent(descriptor) {
    if (!descriptor) return false;
    try {
      if (descriptor.kind === "memory" && descriptor.snapshot.byteIdentity) {
        return this.index.sourceFiles.snapshotCurrent(descriptor.snapshot, this.settings);
      }
      const current = this.index.readIndexedSource(descriptor.relative, descriptor.kind), source = descriptor.snapshot;
      return current.hash === source.hash && (source.authorityStamp === undefined || current.authorityStamp === source.authorityStamp);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "MEMORY_PATH_NOT_ALLOWED", "MEMORY_SOURCE_CHANGED", "MEMORY_SESSION_REVOKED", "CONVERSATION_EVENT_NOT_FOUND"].includes(error.code)) return false;
      throw error;
    }
  }
  assertSnapshot(descriptor) {
    if (!descriptor) throw failed("MEMORY_SCOPE_REVOKED");
    if (!this.snapshotCurrent(descriptor)) throw failed(descriptor.kind === "sessions" ? "MEMORY_SESSION_CHANGED" : "MEMORY_SOURCE_CHANGED");
  }
  beginSyncProviderGeneration(options) {
    const previous = this.syncProviderGeneration;
    super.beginSyncProviderGeneration(options);
    if (!previous && this.syncProviderGeneration?.kind === "semantic") this.syncProviderGeneration.embeddingDimensions = this.index.embeddingDimensions;
  }
  async prepareIndexEntry(entry, source, generation) {
    this.assertCurrent();
    const descriptor = this.sourceJobs.getStore()?.get(`${source}:${entry.path}`);
    if (!descriptor) throw failed("MEMORY_SCOPE_REVOKED");
    const prepared = await super.prepareIndexEntry(entry, source, generation);
    if (prepared && source === "memory" && /^(DREAMS|dreams)\.md$/u.test(entry.path)) {
      this.assertSnapshot(descriptor);
      const current = this.index.readIndexedSource(entry.path, source);
      if (current.hash !== descriptor.snapshot.hash) throw failed("MEMORY_SOURCE_CHANGED");
      prepared.chunks = this.index.prepareSourceChunks(entry.path, source, current, {
        ...(generation?.kind === "semantic" ? { provider: { id: generation.provider.id, maxInputTokens: generation.provider.maxInputTokens } } : {}),
        hardMaxInputTokens: 8000,
      });
    }
    if (prepared) for (const chunk of prepared.chunks) {
      chunk.provenance = this.index.provenanceFor(entry.path, chunk, descriptor.snapshot) || chunk.provenance;
    }
    return prepared;
  }
  withCandidates(candidates, generation, action) {
    const descriptors = new Set(), hashes = new Map();
    for (const candidate of candidates) {
      const descriptor = this.sourceJobs.getStore()?.get(`${candidate.source}:${candidate.entry.path}`);
      if (!descriptor || descriptor.snapshot.hash !== candidate.entry.hash) throw failed("MEMORY_SOURCE_CHANGED");
      descriptors.add(descriptor);
      const entries = hashes.get(candidate.chunk.hash) || [];
      if (!entries.includes(descriptor)) entries.push(descriptor);
      hashes.set(candidate.chunk.hash, entries);
    }
    return this.candidateScopes.run(hashes, () => core.withMemoryEmbeddingExecution({
      signal: core.memoryEmbeddingExecutionSignal(), assertCurrent: () => this.index.assertConfig(this.stamp),
      assertRequestCurrent: () => { for (const descriptor of descriptors) this.assertSnapshot(descriptor); },
    }, async () => {
      const vectors = await action(); this.assertCurrent();
      const dimensions = generation.embeddingDimensions ?? vectors[0]?.length;
      if (vectors.length !== candidates.length || vectors.some(vector => vector.length > 16_384 || !core.isValidMemoryEmbedding(vector, dimensions))) {
        throw failed("MEMORY_EMBEDDING_INVALID");
      }
      generation.embeddingDimensions = dimensions;
      return vectors;
    }));
  }
  embedChunksWithBatch(candidates, source, generation, debugContext) {
    return this.withCandidates(candidates, generation, () => super.embedChunksWithBatch(candidates, source, generation, debugContext));
  }
  embedChunksInBatches(candidates, generation, maxTokens) {
    return this.withCandidates(candidates, generation, () => super.embedChunksInBatches(candidates, generation, maxTokens));
  }
  async ensureVectorReady(dimensions) {
    this.assertCurrent();
    if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16_384
      || this.index.embeddingDimensions !== undefined && this.index.embeddingDimensions !== dimensions) throw failed("MEMORY_EMBEDDING_INVALID");
    this.database.embeddingDimensions = dimensions;
    if (this.database === this.publishedDatabase) this.index.embeddingDimensions = dimensions;
    // The Product host uses the original bounded vector scanner, not sqlite-vec.
    return false;
  }

  async indexSources(descriptors, signal, { forceFtsOnly = false, database = this.publishedDatabase } = {}) {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const sources = new Map(descriptors.map(descriptor => [`${descriptor.kind}:${descriptor.relative}`, descriptor]));
    const items = descriptors.map(({ relative, kind, snapshot }) => ({ source: kind, entry: {
      ...(kind === "memory" ? snapshot : {}),
      path: relative, absPath: path.resolve(this.workspaceDir, relative), hash: snapshot.hash,
      mtimeMs: snapshot.mtime, size: snapshot.size,
      ...(kind === "sessions" ? { sessionId: this.index.sessionIdForPath(relative), content: snapshot.text,
        lineMap: snapshot.lineMap, lineProvenance: snapshot.lineProvenance } : {}),
    } }));
    return this.sourceJobs.run(sources, () => core.withMemoryEmbeddingExecution({ signal,
      assertCurrent: () => this.index.assertConfig(this.stamp) }, async () => {
      this.withPublishedDatabase(() => this.beginSyncProviderGeneration({ forceFtsOnly }));
      try { await this.databaseScopes.run(database, () => super.indexFiles(items)); }
      catch (error) {
        this.assertCurrent();
        if (error.code === "MEMORY_EMBEDDING_OPERATION_FAILED" || error.code === "MEMORY_EMBEDDING_INVALID"
          || error.message === "memory embeddings: malformed vector response (count, dimensions, or coordinates)") throw this.managerEmbeddingError(error);
        throw error;
      } finally { this.endSyncProviderGeneration(); }
    }));
  }

  descriptorForEntry(entry, source) {
    const existing = this.sourceJobs.getStore()?.get(`${source}:${entry.path}`);
    if (existing) return existing;
    // Native source discovery and the scoped Product transcript builder supply
    // these snapshots. Keep only the current native batch's flattened content.
    if (source === "memory" && (!entry.authorityStamp || !entry.byteIdentity)) throw failed("MEMORY_SCOPE_REVOKED");
    if (source === "sessions" && (entry.sessionId !== this.index.sessionIdForPath(entry.path)
      || entry.absPath !== path.join(this.workspaceDir, ".session-source", entry.sessionId))) throw failed("MEMORY_SCOPE_REVOKED");
    return { relative: entry.path, kind: source,
      snapshot: { ...entry, text: source === "sessions" ? entry.content : entry.text, mtime: entry.mtimeMs } };
  }
  indexFile(entry, source) {
    const descriptor = this.descriptorForEntry(entry, source);
    return this.sourceJobs.run(new Map([[`${source}:${entry.path}`, descriptor]]), () => super.indexFile(entry, source));
  }
  indexFiles(items) {
    const descriptors = new Map(items.map(({ entry, source }) => [`${source}:${entry.path}`, this.descriptorForEntry(entry, source)]));
    return this.sourceJobs.run(descriptors, () => super.indexFiles(items));
  }
  async syncSources(signal, { forceFtsOnly = false, database = this.publishedDatabase, needsFullReindex = false,
    shouldSyncMemory, shouldSyncSessions, needsFullSessionReindex, progress, params, freshness = true } = {}) {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    return core.withMemoryEmbeddingExecution({ signal, assertCurrent: () => this.index.assertConfig(this.stamp) }, async () => {
      this.sources.clear();
      for (const source of this.settings.sources) this.sources.add(source);
      const targeted = !needsFullReindex && core.hasTargetedSessionSyncParams(params);
      const targetPlan = targeted ? await this.resolveTargetSessionSyncPlan(params) : null;
      if (targeted && !targetPlan) return;
      if (this.sources.has("sessions") && !needsFullReindex && freshness && !targeted) {
        // Explicit Product reads retain a freshness barrier. Background work
        // consumes only native dirty state and actual targeted queue plans.
        for (const entry of await this.listSessionCorpusEntries()) this.sessionsDirtyFiles.add(entry.sessionFile);
      }
      this.withPublishedDatabase(() => this.beginSyncProviderGeneration({ forceFtsOnly }));
      try {
        await this.databaseScopes.run(database, async () => {
          if (targetPlan && !this.sessionsFullRetryDirty) {
            this.sessionsDirty = core.markMemoryTargetArchiveFilesDirty({ sessionsDirtyFiles: this.sessionsDirtyFiles,
              targetArchiveFiles: targetPlan.targetArchiveFiles });
            const result = await core.runMemoryTargetedSessionSync({ hasSessionSource: this.sources.has("sessions"),
              targetArchiveFiles: targetPlan.targetArchiveFiles, progress, sessionsFullRetryDirty: this.sessionsFullRetryDirty,
              sessionsReconcileDirty: this.sessionsReconcileDirty, sessionsDirtyFiles: this.sessionsDirtyFiles,
              syncArchiveFiles: request => this.syncArchiveFiles({ ...request, corpusEntries: targetPlan.corpusEntries }),
              activateFallbackProvider: async () => false });
            this.sessionsDirty = result.sessionsDirty;
            if (result.handled) return;
          }
          await super.executeSourceSync({ shouldSyncMemory: shouldSyncMemory ?? this.sources.has("memory"),
            shouldSyncSessions: shouldSyncSessions ?? this.sources.has("sessions"), needsFullReindex,
            needsFullSessionReindex: needsFullSessionReindex ?? (needsFullReindex || this.sessionsFullRetryDirty),
            targetArchiveFiles: targetPlan && !this.sessionsFullRetryDirty ? [...targetPlan.targetArchiveFiles] : undefined, progress });
        });
        if (!database.isShadow) await this.pruneEmbeddingCacheIfNeeded();
      } catch (error) {
        this.assertCurrent();
        if (error.code === "MEMORY_EMBEDDING_OPERATION_FAILED" || error.code === "MEMORY_EMBEDDING_INVALID"
          || error.message === "memory embeddings: malformed vector response (count, dimensions, or coordinates)") throw this.managerEmbeddingError(error);
        throw error;
      } finally { this.endSyncProviderGeneration(); }
    });
  }

  async query(text, signal) {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    return core.withMemoryEmbeddingExecution({ signal, assertCurrent: () => this.index.assertConfig(this.stamp) }, async () => {
      try { return await this.embedQueryWithRetry(text, signal); }
      catch (error) { this.assertCurrent(); throw safeEmbeddingError(error); }
    });
  }
  status() { return { batchEnabled: this.batch.enabled, batchFailureCount: this.batchFailure.count }; }
  async close() {
    this.closed = true;
    this.lifetime.abort(failed("MEMORY_EMBEDDING_CANCELLED"));
    await Promise.allSettled([...this.pending]);
  }
}

module.exports = { MemoryIndexEmbedding };
