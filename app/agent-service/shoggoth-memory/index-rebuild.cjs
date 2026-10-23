"use strict";

const fs = require("node:fs");
const { openDatabase } = require("../inspiration-database");
const { preparePrivateParent } = require("../private-file");
const { validatePrivateFileStat } = require("../security");
const { core } = require("./host.cjs");

const failed = code => Object.assign(new Error(code), { code });

// The original sync policy owns the shadow lifecycle, retry state, metadata,
// publication ordering and cleanup. Product supplies admitted source snapshots
// and its native SQLite connections; cache writes stay on the published owner.
class MemoryIndexRebuild extends core.MemoryIndexRebuildPolicy {
  constructor(index, descriptors, stamp, signal, { forceFtsOnly = false } = {}) {
    super();
    this.index = index;
    this.executor = index.embeddingExecutor;
    this.descriptors = descriptors;
    this.stamp = stamp;
    this.signal = signal;
    this.forceFtsOnly = forceFtsOnly;
    this.agentId = index.agentId;
    this.workspaceDir = index.workspaceDir;
    this.cfg = index.getConfig();
    this.settings = { ...index.settings, store: { ...index.settings.store, vector: { enabled: false } } };
    this.cache = this.settings.cache;
    this.publishedDatabase = this.executor.publishedDatabase;
    this.provider = forceFtsOnly ? null : this.executor.provider;
    this.providerRuntime = forceFtsOnly ? undefined : this.executor.providerRuntime;
    this.providerLifecycle = index.searchOwner.providerLifecycle;
    this.fallbackFrom = index.searchOwner.fallbackFrom;
    this.fallbackReason = index.searchOwner.fallbackReason;
    this.providerKey = this.resolveProviderIndexIdentities()[0].providerKey;
    this.batch = this.executor.batch;
    for (const source of this.settings.sources) this.sources.add(source);
    if (index.rebuildRetryState) this.adoptReindexRetryState(index.rebuildRetryState);
    for (const field of ["dirty", "memoryFullRetryDirty", "sessionsDirty", "sessionsFullRetryDirty", "sessionsReconcileDirty", "sessionsDirtyFiles"]) {
      Object.defineProperty(this, field, { configurable: true,
        get: () => this.executor[field], set: value => { this.executor[field] = value; } });
    }
    this.dirty ||= this.sources.has("memory");
    this.sessionsDirty ||= this.sources.has("sessions");
  }

  assertCurrent() {
    this.signal?.throwIfAborted();
    this.index.assertConfig(this.stamp);
    if (this.closed || this.index.rebuildOwner !== this || this.index.db !== this.publishedDatabase.db) throw failed("MEMORY_SCOPE_REVOKED");
  }
  assertSources() {
    this.assertCurrent();
    // Upstream skips files changed before their source publication. Only rows
    // actually admitted to this shadow must stay current through final commit.
    for (const descriptor of this.shadow?.publishedSources.values() || []) this.executor.assertSnapshot(descriptor);
  }
  resolveProviderIndexIdentities() {
    return core.resolveMemoryIndexProviderIdentities({ provider: this.provider, cacheKeyData: this.providerRuntime?.cacheKeyData,
      aliases: this.providerRuntime?.indexIdentityAliases });
  }
  shouldSyncSessions() { return this.sources.has("sessions"); }
  assertRequiredProviderAvailable(operation) {
    this.assertCurrent();
    if (!this.forceFtsOnly && this.index.usesNativeProvider(this.settings)) this.index.searchOwner.assertRequiredProviderAvailable(operation);
  }
  resetProviderInitializationForRetry() {
    this.assertCurrent();
    if (this.index.usesNativeProvider(this.settings)) this.index.searchOwner.resetProviderInitializationForRetry();
  }
  beginSyncProviderGeneration(options) {
    if (this.generationOwned) return;
    this.executor.withPublishedDatabase(() => this.executor.beginSyncProviderGeneration(options));
    this.syncProviderGeneration = this.executor.syncProviderGeneration;
    this.generationOwned = true;
  }
  endSyncProviderGeneration() {
    if (!this.generationOwned) return;
    this.executor.endSyncProviderGeneration();
    this.generationOwned = false;
    this.syncProviderGeneration = null;
  }
  async activateFallbackProvider(reason) {
    this.assertCurrent();
    if (this.forceFtsOnly || !this.index.usesNativeProvider(this.settings)) return false;
    const owner = this.index.searchOwner;
    const activated = await owner.activateFallbackProvider(reason);
    this.assertCurrent();
    this.provider = owner.provider;
    this.providerRuntime = owner.providerRuntime;
    this.providerLifecycle = owner.providerLifecycle;
    this.fallbackFrom = owner.fallbackFrom;
    this.fallbackReason = owner.fallbackReason;
    this.providerKey = this.resolveProviderIndexIdentities()[0].providerKey;
    this.batch = this.executor.batch;
    return activated;
  }
  async syncArchiveFiles(params) {
    this.assertCurrent();
    return core.withMemoryEmbeddingExecution({ signal: this.signal, assertCurrent: () => this.assertCurrent() }, async () => {
      this.executor.withPublishedDatabase(() => this.executor.beginSyncProviderGeneration({ forceFtsOnly: this.forceFtsOnly }));
      try {
        await this.executor.databaseScopes.run(this.database, () => this.executor.syncArchiveFiles(params));
      } catch (error) {
        this.assertCurrent();
        if (error.code === "MEMORY_EMBEDDING_OPERATION_FAILED") throw this.executor.managerEmbeddingError(error);
        throw error;
      } finally { this.executor.endSyncProviderGeneration(); }
    });
  }
  async executeSourceSync({ shouldSyncMemory, shouldSyncSessions, needsFullReindex, needsFullSessionReindex, targetArchiveFiles, progress }) {
    this.assertCurrent();
    await this.executor.syncSources(this.signal, { database: this.database, forceFtsOnly: this.forceFtsOnly,
      shouldSyncMemory, shouldSyncSessions, needsFullReindex, needsFullSessionReindex, progress, freshness: this.freshness,
      ...(targetArchiveFiles ? { params: { archiveFiles: targetArchiveFiles } } : {}) });
    this.assertSources();
    this.clearMemoryRetryState(); this.clearSessionRetryState();
  }
  async pruneEmbeddingCacheIfNeeded() { await this.executor.pruneEmbeddingCacheIfNeeded(); }

  openShadow(filename, allowExtension) {
    this.assertCurrent();
    if (this.shadow?.closed && this.shadow.shadowReleased
      && ["", "-wal", "-shm", "-journal"].every(suffix => !fs.existsSync(this.shadow.shadowPath + suffix))) this.shadow = null;
    const prefix = `${this.index.databasePath}.memory-reindex-`;
    if (allowExtension || this.shadow || !filename.startsWith(prefix)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(filename.slice(prefix.length))) throw failed("MEMORY_SCOPE_REVOKED");
    preparePrivateParent(filename, this.index.host.paths.trustedRoot);
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.closeSync(fd);
    const identity = core.readMemoryShadowIdentity(filename);
    const assertPath = () => {
      validatePrivateFileStat(fs.lstatSync(filename), filename);
      core.assertMemoryShadowIdentity(filename, identity);
    };
    let db;
    try {
      db = openDatabase(filename); assertPath();
      const resource = this.executor.createDatabase(db, { shadow: true });
      let close;
      Object.assign(resource, {
        shadowPath: filename, shadowReleased: false, assertShadowPath: assertPath,
        admitSchema: async ({ ftsTokenizer }) => {
          this.assertCurrent(); assertPath(); this.index.admitSchema(db, ftsTokenizer);
        },
        closeShadow: () => close ??= (async () => {
          resource.closed = true;
          await Promise.allSettled([...resource.pending]);
          db.close(); resource.shadowReleased = true;
        })(),
      });
      this.shadow = resource;
      return resource;
    } catch (error) {
      db?.close();
      assertPath(); fs.unlinkSync(filename);
      throw error;
    }
  }

  publishShadow(publication, assertNativeCurrent) {
    this.assertSources(); assertNativeCurrent();
    const shadow = this.shadow;
    if (!shadow?.shadowReleased || publication.sourcePath !== shadow.shadowPath) throw failed("MEMORY_SCOPE_REVOKED");
    shadow.assertShadowPath();
    const check = () => { this.assertSources(); assertNativeCurrent(); shadow.assertShadowPath(); };
    core.publishMemoryDatabaseTables({ ...publication, targetDb: this.index.db,
      onBegin: check,
      withCommit: commit => {
        check();
        this.index.writePublicationMetadata(shadow.embeddingDimensions);
        this.index.db.prepare("UPDATE memory_index_state SET revision=revision+1 WHERE id=1").run();
        commit();
      },
    });
    this.index.embeddingDimensions = shadow.embeddingDimensions;
    this.publishedDatabase.embeddingDimensions = shadow.embeddingDimensions;
  }

  async run(params, { force = true, freshness = true } = {}) {
    this.freshness = freshness;
    if (this.index.rebuildOwner) throw failed("MEMORY_SCOPE_REVOKED");
    this.index.rebuildOwner = this;
    this.publishedDatabase.publishShadow = (publication, assertCurrent) => this.publishShadow(publication, assertCurrent);
    try {
      await core.withMemoryEmbeddingExecution({ signal: this.signal, assertCurrent: () => this.assertCurrent() },
        () => this.syncOutcomes.track(() => super.runSync({ ...params, force,
          reason: force ? params?.reason ?? "search-bootstrap" : params?.reason }), true));
      if (this.index.usesNativeProvider(this.settings) && this.syncOutcomes.lastError) {
        // Native optional/targeted failures may return with dirty work retained.
        // Surface that actual native outcome through the Product error contract.
        if (!this.index.searchOwner.provider) this.index.searchOwner.resetProviderInitializationForRetry();
        throw failed("MEMORY_EMBEDDING_UNAVAILABLE");
      }
    } finally {
      this.endSyncProviderGeneration();
      this.index.rebuildRetryState = this.snapshotReindexRetryState();
      delete this.publishedDatabase.publishShadow;
      this.closed = true;
      if (this.index.rebuildOwner === this) this.index.rebuildOwner = null;
    }
  }
}

module.exports = { MemoryIndexRebuild };
