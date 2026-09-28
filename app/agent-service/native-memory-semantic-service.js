"use strict";

const { LocalEmbeddingService, bounded } = require("./local-embedding-service");
const { hashText } = require("./e5-encoder");
const { hasSecret, workspaceMemoryRef } = require("./memory-engine");
const { SEMANTIC_MIN_COSINE } = require("./memory-semantic-ranking");

// Owns disposable native recall indexes. Authoritative stores and access checks
// stay in the parent; the child receives only already eligible source documents.
class NativeMemorySemanticService {
  constructor({ paths, memoryEngine, embeddingFactory = () => new LocalEmbeddingService({ paths }) }) {
    this.engine = memoryEngine;
    this.embeddingFactory = embeddingFactory;
    this.embedding = embeddingFactory();
    this.jobs = new Map();
    this.timers = new Map();
    this.epochs = new Map();
    this.closed = false;
    this.blockedProfiles = new Set();
  }
  start() {
    if (this.closed) { this.embedding = this.embeddingFactory(); this.closed = false; }
    this.blockedProfiles.clear();
    return this.embedding.start();
  }
  _key(profileId, domain) { return `${profileId}\0${domain}`; }
  status(profileId, domain = "memory") {
    const model = this.embedding.status();
    const job = this.jobs.get(this._key(profileId, domain));
    return { ...model, coverage: job?.state ?? "unindexed",
      ...(job?.counts ? job.counts : {}), ...(job?.reason ? { indexReason: job.reason } : {}) };
  }
  ensure({ profileId, domain, stamp, documents, isCurrent }) {
    if (this.closed || this.blockedProfiles.has(profileId)) return null;
    const key = this._key(profileId, domain);
    const prior = this.jobs.get(key);
    if (prior?.stamp === stamp && (prior.state !== "unavailable" || Date.now() < prior.retryAt)) return prior;
    const job = { stamp, state: "rebuilding", counts: null,
      epoch: this.epochs.get(profileId) ?? 0, cancelled: false };
    if (prior) prior.cancelled = true;
    this.jobs.set(key, job);
    const current = () => !this.closed && !job.cancelled && !this.blockedProfiles.has(profileId)
      && job.epoch === (this.epochs.get(profileId) ?? 0) && this.jobs.get(key) === job && isCurrent();
    job.promise = (async () => {
      await this.embedding.start();
      if (!current()) return;
      if (prior?.state === "rebuilding") await this.embedding.request("cancel", { profileId, domain });
      if (!current()) return;
      const ready = await this.embedding.request("ready", { profileId, domain, stamp });
      if (!current()) return;
      if (!ready.ready) {
        const { epoch } = await this.embedding.request("begin", { profileId, domain, stamp });
        for await (const document of documents()) {
          if (!current()) return;
          if (hasSecret(document.text)) continue;
          await this.embedding.request("upsert", { profileId, domain, stamp, epoch, document }, { timeoutMs: 30_000 });
        }
        if (!current()) return;
        job.counts = await this.embedding.request("commit", { profileId, domain, stamp, epoch });
      }
      if (current()) job.state = "ready";
    })().catch(error => {
      if (!current()) return;
      job.state = "unavailable"; job.reason = error.code || "E5_INDEX_UNAVAILABLE";
      job.retryAt = Date.now() + 30_000;
      if (error.code === "E5_INDEX_CORRUPT") this.invalidateProfile(profileId);
    });
    return job;
  }
  ensureMemory(profileId) {
    const stamp = this.engine.semanticStamp(profileId);
    return this.ensure({ profileId, domain: "memory", stamp,
      documents: () => this.engine.semanticDocuments(profileId),
      isCurrent: () => this.engine.opened && this.engine.semanticStamp(profileId) === stamp });
  }
  scheduleMemory(profileId) {
    if (this.closed || this.blockedProfiles.has(profileId) || this.timers.has(profileId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(profileId);
      try { this.ensureMemory(profileId); } catch {}
    }, 250);
    timer.unref?.(); this.timers.set(profileId, timer);
  }
  async query({ profileId, domain, job, query, filter, limit = 60, budgetMs = 400 }) {
    if (!job || !query?.trim() || hasSecret(query)) return { status: "unavailable", results: [] };
    const key = this._key(profileId, domain);
    try {
      return await bounded((async () => {
        await job.promise;
        if (job.state !== "ready" || this.jobs.get(key) !== job || job.cancelled
          || this.blockedProfiles.has(profileId)) return { status: job.state, results: [] };
        const value = await this.embedding.request("query", { profileId, domain, stamp: job.stamp,
          query, filter, limit }, { timeoutMs: budgetMs });
        if (this.jobs.get(key) !== job || job.cancelled || this.closed
          || this.blockedProfiles.has(profileId)) return { status: "rebuilding", results: [] };
        // A replaced, removed or version-mismatched cache may have lost its
        // stamp while the parent still remembers a ready job. The next lookup
        // must enumerate authoritative sources again rather than stay stale.
        if (value.status === "rebuilding") {
          job.cancelled = true; job.state = "rebuilding"; this.jobs.delete(key);
        }
        return value;
      })(), budgetMs);
    } catch (error) {
      if (error.code === "E5_INDEX_CORRUPT") this.invalidateProfile(profileId);
      return { status: error.code === "E5_TIMEOUT" ? "timeout" : "unavailable", results: [] };
    }
  }
  async memoryCandidates(input, budgetMs = 400) {
    let job;
    try { job = this.ensureMemory(input.profileId); } catch { return { status: "unavailable", candidates: [] }; }
    const value = await this.query({ profileId: input.profileId, domain: "memory", job, query: input.query,
      filter: { now: this.engine.now(), scopes: input.scopes,
        maxSensitivity: input.maxSensitivity === "private" ? 1 : 0,
        workspaceRef: workspaceMemoryRef(input.workspace) }, budgetMs });
    if (this.closed || this.blockedProfiles.has(input.profileId)
      || this.engine.semanticStamp(input.profileId) !== job?.stamp) return { status: "rebuilding", candidates: [] };
    const candidates = value.results.filter(row => row.score >= SEMANTIC_MIN_COSINE).flatMap(row => {
      const item = this.engine.store.get(input.profileId, row.source.sourceId);
      return item && hashText(item.content) === row.contentHash ? [{ id: item.id, score: row.score, rankScore: row.rankScore }] : [];
    });
    return { status: value.status, candidates, stamp: job.stamp };
  }
  async searchMemory(input) {
    const semantic = await this.memoryCandidates(input);
    return { ...this.engine.search({ ...input, semanticCandidates: semantic.candidates }),
      semantic: { status: semantic.status, modelId: "intfloat/multilingual-e5-small",
        approximate: true, requiresContentVerification: true } };
  }
  invalidateProfile(profileId) {
    this.epochs.set(profileId, (this.epochs.get(profileId) ?? 0) + 1);
    for (const [key, job] of this.jobs) if (key.startsWith(`${profileId}\0`)) {
      job.cancelled = true; this.jobs.delete(key);
    }
    if (this.embedding.state === "ready" || this.embedding.state === "loading") {
      void this.embedding.request("reset", { profileId }, { timeoutMs: 20_000 }).catch(() => {});
    }
  }
  forgetProfile(profileId) {
    this.blockedProfiles.add(profileId);
    clearTimeout(this.timers.get(profileId)); this.timers.delete(profileId);
    this.invalidateProfile(profileId);
  }
  async close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const job of this.jobs.values()) job.cancelled = true;
    this.jobs.clear();
    await this.embedding.close();
  }
}

module.exports = { NativeMemorySemanticService };
