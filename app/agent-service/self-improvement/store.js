"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { openDatabase, transaction } = require("../inspiration-database");
const { preparePrivateParent, fsyncPrivateParent, atomicWritePrivateFile, readPrivateFile } = require("../private-file");
const { acquirePrivateWriterLease } = require("../private-writer-lease");
const { validateCanonicalOwnedDirectory } = require("../runtime-storage-inspector");
const { hasSecret } = require("../memory-engine");
const { DEFAULT_CONFIG, POLICY_VERSION, LIMITS, DAY_MS, fail, digest, id, hash, integer,
  validateConfig, validateProposal, reviewRequired, migrateLegacyConfig, reviewInputBudget } = require("./protocol");

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE settings(profile_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE sources(profile_id TEXT NOT NULL,run_id TEXT NOT NULL,session_key TEXT NOT NULL,
  state TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(profile_id,run_id));
CREATE INDEX sources_pending ON sources(profile_id,session_key,state);
CREATE TABLE jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,profile_id TEXT NOT NULL,
  state TEXT NOT NULL,created_at INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX jobs_pending ON jobs(state,seq);
CREATE INDEX jobs_profile ON jobs(profile_id,seq DESC);
CREATE TABLE calls(job_id TEXT NOT NULL,attempt INTEGER NOT NULL,profile_id TEXT NOT NULL,day TEXT NOT NULL,
  charge INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(job_id,attempt));
CREATE INDEX calls_day ON calls(day,profile_id);
CREATE TABLE skills(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL,head TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX skills_profile ON skills(profile_id,seq DESC);
CREATE TABLE versions(skill_id TEXT NOT NULL,hash TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(skill_id,hash));
CREATE TABLE evidence(skill_id TEXT NOT NULL,version_hash TEXT NOT NULL,profile_id TEXT NOT NULL,session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(skill_id,version_hash,event_id));
CREATE INDEX evidence_source ON evidence(profile_id,session_id,event_id);
CREATE TABLE usage(run_id TEXT NOT NULL,skill_id TEXT NOT NULL,version_hash TEXT NOT NULL,kind TEXT NOT NULL,
  profile_id TEXT NOT NULL,created_at INTEGER NOT NULL,outcome TEXT,PRIMARY KEY(run_id,skill_id,version_hash,kind));
CREATE INDEX usage_skill ON usage(skill_id,created_at);
CREATE TABLE leases(run_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,profile_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE notices(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,created_at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL CHECK(json_valid(data)));
PRAGMA user_version=2;
`;
const parse = row => row ? JSON.parse(row.data) : null;
const clone = value => structuredClone(value);
const dayOf = at => { const date = new Date(at); return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join("-"); };
const validUsage = usage => usage && integer(usage.inputTokens) && integer(usage.outputTokens);
function boundedPage(rows, limit, project) {
  const items = []; let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const item = project(row), size = Buffer.byteLength(JSON.stringify(item));
    if (items.length && bytes + size > 30 * 1024) break;
    items.push(item); bytes += size;
  }
  return { items, nextCursor: rows.length > items.length ? rows[items.length - 1]?.seq ?? null : null };
}

class LearningStore {
  constructor({ paths, now = Date.now, database = openDatabase }) {
    this.paths = paths; this.now = now; this.openDatabase = database; this.db = null; this.lease = null;
    this.filePath = path.join(paths.stateDir, "self-improvement.sqlite");
  }
  open() {
    if (this.db) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot);
    const lease = acquirePrivateWriterLease({ lockPath: path.join(this.paths.stateDir, "self-improvement.writer.lock"), trustedRoot: this.paths.trustedRoot });
    try {
      this.db = this.openDatabase(this.filePath);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1, 2].includes(version)) fail("LEARNING_STORE_CORRUPT");
      if (version === 0) { transaction(this.db, () => this.db.exec(SCHEMA)); fsyncPrivateParent(this.paths.stateDir); }
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("LEARNING_STORE_CORRUPT");
      for (const [table, fields] of [
        ["settings", [["profile_id", "profileId"], ["revision", "revision"]]],
        ["sources", [["profile_id", "profileId"], ["run_id", "runId"], ["state", "state"]]],
        ["jobs", [["id", "id"], ["profile_id", "profileId"], ["state", "state"], ["revision", "revision"]]],
        ["skills", [["id", "id"], ["profile_id", "profileId"], ["head", "head"], ["revision", "revision"]]],
        ["versions", [["skill_id", "skillId"], ["hash", "hash"]]],
      ]) {
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE ${fields.map(([column, field]) => `${column} IS NOT json_extract(data,'$.${field}')`).join(" OR ")} LIMIT 1`).get())
          fail("LEARNING_STORE_CORRUPT");
      }
      if (version === 1) transaction(this.db, () => {
        for (const row of this.db.prepare("SELECT data FROM settings").all()) {
          const before = parse(row), config = migrateLegacyConfig(before.config);
          const value = { ...before, config, revision: before.revision + 1, updatedAt: this.now() };
          this.db.prepare("UPDATE settings SET revision=?,data=? WHERE profile_id=?")
            .run(value.revision, JSON.stringify(value), value.profileId);
        }
        this.db.exec("PRAGMA user_version=2");
      });
      for (const row of this.db.prepare("SELECT data FROM settings").all()) validateConfig(parse(row).config);
      for (const row of this.db.prepare("SELECT * FROM calls").all()) {
        const call = parse(row);
        if (!id(row.job_id) || !id(row.profile_id) || !integer(row.attempt, 1, LIMITS.calls) || !integer(row.charge)
          || call.jobId !== row.job_id || call.profileId !== row.profile_id || call.attempt !== row.attempt
          || !integer(call.estimatedInputTokens, 1) || !integer(call.reservedTokens, call.estimatedInputTokens)
          || call.usage !== null && !validUsage(call.usage)) fail("LEARNING_STORE_CORRUPT");
      }
      this.lease = lease;
      transaction(this.db, () => {
        for (const row of this.db.prepare("SELECT data FROM jobs WHERE state IN ('reviewing','validating')").all()) {
          const job = parse(row);
          this._writeJob({ ...job, state: "outcome_unknown", reason: "service_restarted", updatedAt: this.now(), revision: job.revision + 1 });
        }
      });
      this.cleanupPackages();
      return this;
    } catch (error) { this.db?.close(); this.db = null; this.lease = null; lease.release(); throw error; }
  }
  close() {
    try { if (this.db) { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { this.db.close(); } } }
    finally { this.db = null; this.lease?.release(); this.lease = null; }
  }
  ready() { if (!this.db || !this.lease) fail("LEARNING_UNAVAILABLE"); }
  meta(key, fallback = null) { this.ready(); const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key); return row ? JSON.parse(row.value) : fallback; }
  setMeta(key, value) { this.ready(); this.db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
  settings(profileId) {
    this.ready(); if (!id(profileId)) fail();
    const value = parse(this.db.prepare("SELECT data FROM settings WHERE profile_id=?").get(profileId));
    if (value) { validateConfig(value.config); return value; }
    const fresh = { profileId, revision: 0, config: clone(DEFAULT_CONFIG), coverageStartedAt: this.now(), updatedAt: this.now() };
    this.db.prepare("INSERT INTO settings VALUES (?,?,?)").run(profileId, 0, JSON.stringify(fresh));
    return fresh;
  }
  hasEnabledConsent() {
    this.ready();
    return this.db.prepare("SELECT data FROM settings").all().some(row => {
      const value = parse(row); return value.consent?.version === POLICY_VERSION && value.config.mode !== "off";
    });
  }
  configure(profileId, expectedRevision, patch, consent = false) {
    validateConfig(patch, true);
    return transaction(this.db, () => {
      const before = this.settings(profileId);
      if (before.revision !== expectedRevision) fail("LEARNING_CONFLICT");
      const config = { ...before.config, ...patch };
      if (config.mode !== "off" && (before.config.mode === "off" || before.consent?.version !== POLICY_VERSION) && consent !== true)
        fail("LEARNING_PROTECTED");
      const value = { ...before, revision: before.revision + 1, updatedAt: this.now(), config,
        ...(config.mode !== "off" && consent ? { consent: { version: POLICY_VERSION, confirmedAt: this.now() } } : {}),
        ...(before.config.mode === "off" && config.mode !== "off" ? { coverageStartedAt: this.now() } : {}) };
      this.db.prepare("UPDATE settings SET revision=?,data=? WHERE profile_id=?").run(value.revision, JSON.stringify(value), profileId);
      if (config.mode === "off") {
        for (const row of this.db.prepare("SELECT data FROM jobs WHERE profile_id=? AND state='queued'").all(profileId)) {
          const job = parse(row);
          this._writeJob({ ...job, state: "canceled", reason: "disabled", revision: job.revision + 1, updatedAt: this.now() });
        }
        this.db.prepare("DELETE FROM sources WHERE profile_id=? AND state='ready'").run(profileId);
      }
      return value;
    });
  }
  source(profileId, runId) { this.ready(); return parse(this.db.prepare("SELECT data FROM sources WHERE profile_id=? AND run_id=?").get(profileId, runId)); }
  observeSource(value) {
    this.ready(); const old = this.source(value.profileId, value.runId);
    if (old?.jobId) return old;
    this.db.prepare("INSERT INTO sources VALUES (?,?,?,?,?) ON CONFLICT(profile_id,run_id) DO UPDATE SET session_key=excluded.session_key,state=excluded.state,data=excluded.data")
      .run(value.profileId, value.runId, value.sessionKey, value.state, JSON.stringify(value));
    return clone(value);
  }
  pendingSources(profileId, sessionKey) {
    this.ready(); return this.db.prepare("SELECT data FROM sources WHERE profile_id=? AND session_key=? AND state='ready' ORDER BY rowid LIMIT 16")
      .all(profileId, sessionKey).map(parse);
  }
  queue(input) {
    this.ready();
    const jobId = `learn-${digest([POLICY_VERSION, input.profileId, input.sourceRefs])}`;
    return transaction(this.db, () => {
      const existing = this.job(jobId);
      if (existing) return existing;
      const job = { ...clone(input), id: jobId, policyVersion: POLICY_VERSION, state: "queued", revision: 1,
        createdAt: this.now(), updatedAt: this.now(), reason: null, proposal: null, resultSkillId: null, route: null };
      this.db.prepare("INSERT INTO jobs(id,profile_id,state,created_at,revision,data) VALUES (?,?,?,?,?,?)")
        .run(job.id, job.profileId, job.state, job.createdAt, job.revision, JSON.stringify(job));
      for (const runId of job.runIds) {
        const source = this.source(job.profileId, runId);
        if (source) { const next = { ...source, state: "queued", jobId };
          this.db.prepare("UPDATE sources SET state=?,data=? WHERE profile_id=? AND run_id=?")
            .run(next.state, JSON.stringify(next), job.profileId, runId); }
      }
      return job;
    });
  }
  job(jobId) { this.ready(); return parse(this.db.prepare("SELECT data FROM jobs WHERE id=?").get(jobId)); }
  _writeJob(job) {
    this.db.prepare("UPDATE jobs SET state=?,revision=?,data=? WHERE id=?").run(job.state, job.revision, JSON.stringify(job), job.id);
    return clone(job);
  }
  updateJob(jobId, expectedRevision, patch, states = null) {
    this.ready(); return transaction(this.db, () => {
      const job = this.job(jobId);
      if (!job || job.revision !== expectedRevision || states && !states.includes(job.state)) fail("LEARNING_CONFLICT");
      const updated = this._writeJob({ ...job, ...clone(patch), revision: job.revision + 1, updatedAt: this.now() });
      if (["pending_review", "failed", "outcome_unknown"].includes(patch.state)) {
        const noticeId = `job-${digest([updated.id, updated.revision])}`;
        this.db.prepare("INSERT INTO notices(id,profile_id,created_at,data) VALUES (?,?,?,?)")
          .run(noticeId, job.profileId, this.now(), JSON.stringify({ id: noticeId, profileId: job.profileId, jobId, state: updated.state }));
      }
      return updated;
    });
  }
  queued(limit = 32) { this.ready(); return this.db.prepare("SELECT data FROM jobs WHERE state='queued' ORDER BY seq LIMIT ?").all(limit).map(parse); }
  budget(profileId) {
    this.ready(); const day = dayOf(this.now());
    const totals = this.db.prepare("SELECT COALESCE(SUM(charge),0) AS tokens,COUNT(DISTINCT job_id) AS runs FROM calls WHERE day=? AND profile_id=?").get(day, profileId);
    const global = this.db.prepare("SELECT COALESCE(SUM(charge),0) AS tokens FROM calls WHERE day=?").get(day);
    const unknown = this.db.prepare("SELECT COUNT(*) AS count FROM calls WHERE day=? AND profile_id=? AND json_extract(data,'$.usage') IS NULL").get(day, profileId);
    return { day, ...totals, globalTokens: global.tokens, unknownCalls: unknown.count };
  }
  calls(jobId) { this.ready(); return this.db.prepare("SELECT data FROM calls WHERE job_id=? ORDER BY attempt").all(jobId).map(parse); }
  beginCall(jobId, expectedRevision, { route, estimatedInputTokens, reserveTokens, maxInputTokens }) {
    if (!integer(estimatedInputTokens, 1) || !integer(reserveTokens, estimatedInputTokens)) fail();
    return transaction(this.db, () => {
      const job = this.job(jobId);
      if (!job || job.revision !== expectedRevision || !["queued", "reviewing"].includes(job.state)) fail("LEARNING_CONFLICT");
      const settings = this.settings(job.profileId), calls = this.calls(jobId);
      if (settings.config.mode === "off" || settings.consent?.version !== POLICY_VERSION || settings.revision !== job.settingsRevision) fail("LEARNING_CONFLICT");
      if (calls.length >= LIMITS.calls) fail("LEARNING_BUDGET");
      const inputBudget = maxInputTokens === undefined ? reviewInputBudget(settings.config) : maxInputTokens;
      if (inputBudget !== null && !integer(inputBudget)) fail();
      // Match Hermes: check consumed input between iterations. A call that
      // crosses the budget can finish and its valid proposal can still publish.
      const consumed = calls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? call.estimatedInputTokens), 0);
      if (inputBudget > 0 && consumed >= inputBudget) fail("LEARNING_INPUT_BUDGET");
      const call = { jobId, attempt: calls.length + 1, profileId: job.profileId, startedAt: this.now(),
        route: clone(route), estimatedInputTokens, reservedTokens: reserveTokens, usage: null, state: "started" };
      this.db.prepare("INSERT INTO calls VALUES (?,?,?,?,?,?)").run(jobId, call.attempt, job.profileId,
        dayOf(call.startedAt), reserveTokens, JSON.stringify(call));
      const updated = this._writeJob({ ...job, route: clone(route), state: "reviewing", revision: job.revision + 1, updatedAt: this.now() });
      return { job: updated, call };
    });
  }
  settleCall(jobId, attempt, usage, state = "completed", model = null) {
    this.ready(); const call = parse(this.db.prepare("SELECT data FROM calls WHERE job_id=? AND attempt=?").get(jobId, attempt));
    if (!call) fail("LEARNING_CONFLICT");
    // Retain the estimate when a Provider has no complete usage receipt.
    const actual = validUsage(usage) ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null;
    const next = { ...call, state, usage: actual, endedAt: this.now(),
      route: { ...call.route, model: typeof model === "string" && model.length <= 512 ? model : call.route.model } };
    this.db.prepare("UPDATE calls SET charge=?,data=? WHERE job_id=? AND attempt=?")
      .run(actual ? actual.inputTokens + actual.outputTokens : call.reservedTokens, JSON.stringify(next), jobId, attempt);
    return next;
  }
  history(profileId, cursor = null, limit = 20) {
    this.ready(); const rows = this.db.prepare("SELECT seq,data FROM jobs WHERE profile_id=? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(profileId, cursor ?? Number.MAX_SAFE_INTEGER, limit + 1);
    return boundedPage(rows, limit, row => { const job = parse(row), { proposal, sourceRefs } = job;
      return { id: job.id, revision: job.revision, state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt,
        reason: job.reason, resultSkillId: job.resultSkillId, runIds: job.runIds,
        sourceCount: sourceRefs.length, proposal: proposal ? { action: proposal.action,
        reason: proposal.reason, title: proposal.title ?? null, description: proposal.description ?? null } : null,
        calls: this.calls(job.id).map(call => ({ attempt: call.attempt, state: call.state,
          startedAt: call.startedAt, endedAt: call.endedAt ?? null, model: call.route.model ?? null,
          runtime: call.route.runtime ?? null, estimatedInputTokens: call.estimatedInputTokens,
          reservedTokens: call.reservedTokens, usage: call.usage })) };
    });
  }
  _versionRoot(profileId, skillId, versionHash) {
    if (!id(profileId) || !id(skillId) || !hash(versionHash)) fail();
    return path.join(this.paths.agentsDir, profileId, "learned-skills", skillId, "versions", versionHash);
  }
  _writePackage(profileId, skillId, proposal, versionIdentity) {
    const name = `learned-${skillId.slice(6, 38)}`;
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(proposal.description)}\n---\n\n# ${proposal.title}\n\n${proposal.body}\n`;
    const files = [{ path: "SKILL.md", content }, ...proposal.references].sort((a, b) => a.path.localeCompare(b.path));
    const versionHash = digest([files, versionIdentity]), root = this._versionRoot(profileId, skillId, versionHash);
    for (const file of files) {
      const target = path.join(root, file.path);
      if (fs.existsSync(target)) {
        if (readPrivateFile(target, { maxBytes: LIMITS.skillBytes }).toString("utf8") !== file.content) fail("LEARNING_STORE_CORRUPT");
      } else atomicWritePrivateFile(target, file.content, { trustedRoot: this.paths.trustedRoot });
    }
    return { name, hash: versionHash, files: files.map(file => ({ path: file.path, hash: digest(file.content) })) };
  }
  skill(skillId, profileId) {
    this.ready(); const skill = parse(this.db.prepare("SELECT data FROM skills WHERE id=?").get(skillId));
    if (!skill || skill.profileId !== profileId) fail("LEARNING_VERSION_UNAVAILABLE");
    return skill;
  }
  version(skillId, versionHash, profileId) {
    this.skill(skillId, profileId);
    const row = this.db.prepare("SELECT revoked,data FROM versions WHERE skill_id=? AND hash=?").get(skillId, versionHash);
    if (!row || row.revoked) fail("LEARNING_VERSION_UNAVAILABLE");
    return parse(row);
  }
  readFile(profileId, skillId, versionHash, relativePath = "SKILL.md") {
    if (relativePath !== "SKILL.md" && !/^references\/[a-z0-9][a-z0-9-]{0,63}\.(?:md|txt)$/u.test(relativePath)) fail("LEARNING_VERSION_UNAVAILABLE");
    const version = this.version(skillId, versionHash, profileId);
    const file = version.files.find(item => item.path === relativePath);
    if (!file) fail("LEARNING_VERSION_UNAVAILABLE");
    const content = readPrivateFile(path.join(this._versionRoot(profileId, skillId, versionHash), file.path), { maxBytes: LIMITS.skillBytes }).toString("utf8");
    if (digest(content) !== file.hash || hasSecret(content)) fail("LEARNING_STORE_CORRUPT");
    return { content, fileHash: file.hash, version };
  }
  allSkills(profileId) { this.ready(); return this.db.prepare("SELECT data FROM skills WHERE profile_id=? ORDER BY seq").all(profileId).map(parse); }
  skillsPage(profileId, cursor = null, limit = 20) {
    this.ready(); const rows = this.db.prepare("SELECT seq,data FROM skills WHERE profile_id=? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(profileId, cursor ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const coverage = this.settings(profileId).coverageStartedAt;
    return boundedPage(rows, limit, row => {
      const skill = parse(row), usage = this.skillUsage(skill.id);
      return { ...skill, usage, observation: skill.owner === "managed" && !skill.archived && !skill.revoked
        && this.now() - Math.max(skill.createdAt, usage.lastUsedAt ?? 0, coverage) >= 14 * DAY_MS ? "unused_14_days" : null };
    });
  }
  versionHistory(profileId, skillId) {
    this.skill(skillId, profileId);
    return this.db.prepare("SELECT revoked,data FROM versions WHERE skill_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10").all(skillId)
      .map(row => { const value = parse(row); return { hash: value.hash, createdAt: value.createdAt,
        baseVersionHash: value.baseVersionHash, reason: value.reason.slice(0, 160), revoked: !!row.revoked }; });
  }
  changes(profileId, skillId) {
    this.skill(skillId, profileId);
    return this.db.prepare("SELECT data FROM receipts WHERE profile_id=? AND skill_id=? ORDER BY seq DESC LIMIT 20").all(profileId, skillId)
      .map(row => { const item = parse(row); return { id: item.id, action: item.action, actor: item.actor,
        beforeHash: item.beforeHash, afterHash: item.afterHash, createdAt: item.createdAt, reason: item.reason.slice(0, 160) }; });
  }
  _receipt(skill, beforeHash, action, actor, reason, jobId = null) {
    const receipt = { id: `change-${digest([skill.id, skill.revision, action])}`, profileId: skill.profileId,
      skillId: skill.id, revision: skill.revision, beforeHash, afterHash: skill.head,
      action, actor, reason, jobId, createdAt: this.now() };
    this.db.prepare("INSERT INTO receipts(id,profile_id,skill_id,created_at,data) VALUES (?,?,?,?,?)")
      .run(receipt.id, skill.profileId, skill.id, receipt.createdAt, JSON.stringify(receipt));
    this.db.prepare("INSERT INTO notices(id,profile_id,created_at,data) VALUES (?,?,?,?)")
      .run(receipt.id, skill.profileId, receipt.createdAt, JSON.stringify({ id: receipt.id, profileId: skill.profileId, skillId: skill.id, action, actor, revision: skill.revision }));
    return receipt;
  }
  publish(jobId, expectedRevision, assertCurrent, { accepted = false } = {}) {
    const candidate = this.job(jobId);
    if (!candidate || candidate.revision !== expectedRevision || !candidate.proposal || candidate.proposal.action === "noop") fail("LEARNING_CONFLICT");
    const proposal = validateProposal(candidate.proposal);
    const skillId = proposal.action === "create" ? `skill-${digest(jobId).slice(0, 40)}` : proposal.skillId;
    const pkg = this._writePackage(candidate.profileId, skillId, proposal, jobId);
    return transaction(this.db, () => {
      assertCurrent();
      const job = this.job(jobId), settings = this.settings(candidate.profileId);
      if (job.revision !== expectedRevision || !["validating", "pending_review"].includes(job.state)
        || settings.config.mode === "off" || settings.consent?.version !== POLICY_VERSION
        || !accepted && settings.revision !== job.settingsRevision) fail("LEARNING_CONFLICT");
      const prior = proposal.action === "patch" ? this.skill(skillId, job.profileId) : null;
      if (prior && (prior.owner !== "managed" || prior.archived || prior.revoked || prior.pinned && !accepted)) fail("LEARNING_PROTECTED");
      if (prior && prior.head !== proposal.baseVersionHash) fail("LEARNING_CONFLICT");
      if (!accepted && (settings.config.mode === "review" || reviewRequired(proposal))) fail("LEARNING_PROTECTED");
      const now = this.now(), skill = { id: skillId, profileId: job.profileId, name: pkg.name,
        title: proposal.title, description: proposal.description, head: pkg.hash, revision: (prior?.revision ?? 0) + 1,
        owner: "managed", pinned: prior?.pinned ?? false, archived: false, revoked: false,
        createdAt: prior?.createdAt ?? now, updatedAt: now, lastJobId: job.id };
      if (prior && digest(this.version(prior.id, prior.head, prior.profileId).files) === digest(pkg.files)) {
        this._writeJob({ ...job, state: "noop", reason: "unchanged_content", revision: job.revision + 1, updatedAt: now });
        return prior;
      }
      const inherited = prior ? this.version(prior.id, prior.head, prior.profileId).sourceRefs : [];
      const refs = [...new Map([...inherited, ...job.sourceRefs].map(ref => [`${ref.sessionId}:${ref.eventId}`, ref])).values()];
      if (refs.length > 256) fail("LEARNING_OUTPUT_INVALID");
      const version = { ...pkg, profileId: job.profileId, skillId, createdAt: now, sourceRefs: refs,
        baseVersionHash: prior?.head ?? null, reason: proposal.reason, jobId, title: proposal.title, description: proposal.description };
      this.db.prepare("INSERT INTO versions(skill_id,hash,created_at,data) VALUES (?,?,?,?) ON CONFLICT(skill_id,hash) DO NOTHING")
        .run(skillId, pkg.hash, now, JSON.stringify(version));
      // Reusing identical bytes must not revive a revoked lineage.
      if (this.db.prepare("SELECT revoked FROM versions WHERE skill_id=? AND hash=?").get(skillId, pkg.hash).revoked) fail("LEARNING_VERSION_UNAVAILABLE");
      this.db.prepare("INSERT INTO skills(id,profile_id,revision,head,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,head=excluded.head,data=excluded.data")
        .run(skillId, skill.profileId, skill.revision, skill.head, JSON.stringify(skill));
      for (const ref of refs) this.db.prepare("INSERT OR IGNORE INTO evidence VALUES (?,?,?,?,?,?)")
        .run(skillId, pkg.hash, job.profileId, ref.sessionId, ref.eventId, ref.runId);
      this._receipt(skill, prior?.head ?? null, proposal.action, accepted ? "user" : "background", proposal.reason, job.id);
      this._writeJob({ ...job, state: "applied", resultSkillId: skillId, reason: null, revision: job.revision + 1, updatedAt: now });
      return skill;
    });
  }
  change(profileId, skillId, expectedRevision, action, assertCurrent, { versionHash, body, actor = "user" } = {}) {
    const before = this.skill(skillId, profileId);
    let edited = null;
    if (action === "edit") {
      const version = this.version(skillId, before.head, profileId);
      edited = { ...this._writePackage(profileId, skillId, { title: before.title, description: before.description, body,
        references: version.files.filter(file => file.path !== "SKILL.md").map(file => ({ path: file.path,
          content: this.readFile(profileId, skillId, before.head, file.path).content })) }, `user-${before.revision + 1}`), sourceRefs: version.sourceRefs };
    }
    return transaction(this.db, () => {
      const skill = this.skill(skillId, profileId);
      if (skill.revision !== expectedRevision) fail("LEARNING_CONFLICT");
      if (skill.revoked) fail("LEARNING_VERSION_UNAVAILABLE");
      assertCurrent(action === "revert" ? versionHash : skill.head);
      const updated = { ...skill, revision: skill.revision + 1, updatedAt: this.now() };
      if (action === "pin" || action === "unpin") updated.pinned = action === "pin";
      else if (action === "archive" || action === "restore") updated.archived = action === "archive";
      else if (action === "adopt") updated.owner = "user";
      else if (action === "revert") { const version = this.version(skillId, versionHash, profileId);
        updated.head = version.hash; updated.title = version.title; updated.description = version.description; }
      else if (action === "edit") {
        updated.owner = "user"; updated.head = edited.hash;
        const version = { ...edited, profileId, skillId, title: skill.title, description: skill.description,
          createdAt: this.now(), baseVersionHash: skill.head, reason: "user_edit", jobId: null };
        this.db.prepare("INSERT INTO versions(skill_id,hash,created_at,data) VALUES (?,?,?,?) ON CONFLICT(skill_id,hash) DO NOTHING")
          .run(skillId, version.hash, version.createdAt, JSON.stringify(version));
        for (const ref of edited.sourceRefs) this.db.prepare("INSERT OR IGNORE INTO evidence VALUES (?,?,?,?,?,?)")
          .run(skillId, version.hash, profileId, ref.sessionId, ref.eventId, ref.runId);
      } else fail();
      this.db.prepare("UPDATE skills SET revision=?,head=?,data=? WHERE id=?")
        .run(updated.revision, updated.head, JSON.stringify(updated), skillId);
      this._receipt(updated, skill.head, action, actor, action);
      return updated;
    });
  }
  captureLease(profileId, runId, available) {
    this.ready(); if (!id(runId)) fail();
    const old = this.leaseFor(profileId, runId); if (old) return old;
    const value = available.map(skill => ({ id: skill.id, hash: skill.head }));
    this.db.prepare("INSERT INTO leases VALUES (?,?,?,?)").run(runId, profileId, this.now(), JSON.stringify(value));
    return value;
  }
  leaseFor(profileId, runId) {
    this.ready(); const row = this.db.prepare("SELECT profile_id,data FROM leases WHERE run_id=?").get(runId);
    if (row && row.profile_id !== profileId) fail("LEARNING_CONFLICT");
    return parse(row);
  }
  recordUsage(profileId, runId, skillId, versionHash, kind = "read") {
    if (!id(runId) || !["read", "selected", "exposed"].includes(kind)) fail();
    this.version(skillId, versionHash, profileId);
    this.db.prepare("INSERT OR IGNORE INTO usage VALUES (?,?,?,?,?,?,NULL)").run(runId, skillId, versionHash, kind, profileId, this.now());
  }
  settleRun(runId, outcome) {
    if (!["completed", "failed", "canceled", "interrupted", "skipped"].includes(outcome)) return;
    this.ready(); this.db.prepare("UPDATE usage SET outcome=? WHERE run_id=? AND outcome IS NULL").run(outcome, runId);
    this.db.prepare("DELETE FROM leases WHERE run_id=?").run(runId);
  }
  skillUsage(skillId) {
    this.ready(); const row = this.db.prepare(`SELECT COUNT(DISTINCT CASE WHEN kind='read' THEN run_id END) AS reads,
      COUNT(DISTINCT CASE WHEN kind='selected' THEN run_id END) AS selections,
      COUNT(DISTINCT CASE WHEN kind='exposed' THEN run_id END) AS exposures,
      MAX(CASE WHEN kind IN ('read','selected') THEN created_at END) AS lastUsedAt FROM usage WHERE skill_id=?`).get(skillId);
    const corrections = this.db.prepare(`SELECT COUNT(DISTINCT usage.run_id) AS count FROM usage JOIN sources
      ON sources.profile_id=usage.profile_id AND sources.run_id=usage.run_id
      WHERE usage.skill_id=? AND usage.kind='read' AND json_extract(sources.data,'$.hasCorrection')=1`).get(skillId).count;
    return { ...row, correctionSignals: corrections,
      outcomes: this.db.prepare("SELECT outcome,COUNT(DISTINCT run_id) AS count FROM usage WHERE skill_id=? AND kind='read' GROUP BY outcome").all(skillId)
      .map(item => ({ outcome: item.outcome, count: item.count })) };
  }
  usedSkillIds(profileId, runIds) {
    this.ready(); if (!runIds.length) return new Set();
    return new Set(this.db.prepare(`SELECT DISTINCT skill_id FROM usage WHERE profile_id=? AND kind IN ('read','selected')
      AND run_id IN (${runIds.map(() => "?").join(",")})`).all(profileId, ...runIds).map(row => row.skill_id));
  }
  activeLease(skillId) {
    this.ready(); return !!this.db.prepare("SELECT 1 FROM leases,json_each(leases.data) AS item WHERE json_extract(item.value,'$.id')=? LIMIT 1").get(skillId);
  }
  sourceVersions(profileId) {
    this.ready(); return this.db.prepare("SELECT versions.data FROM versions JOIN skills ON skills.id=versions.skill_id WHERE skills.profile_id=? AND versions.revoked=0").all(profileId).map(parse);
  }
  sourceJobs(profileId) {
    this.ready(); return this.db.prepare("SELECT data FROM jobs WHERE profile_id=? AND state IN ('queued','pending_review')").all(profileId).map(parse);
  }
  purgeProfile(profileId) {
    this.ready(); if (!id(profileId)) fail();
    const skills = this.allSkills(profileId);
    transaction(this.db, () => {
      for (const skill of skills) this.db.prepare("DELETE FROM versions WHERE skill_id=?").run(skill.id);
      for (const table of ["settings", "sources", "jobs", "calls", "skills", "evidence", "usage", "leases", "receipts", "notices"])
        this.db.prepare(`DELETE FROM ${table} WHERE profile_id=?`).run(profileId);
      for (const row of this.db.prepare("SELECT key FROM meta").all())
        if (row.key.startsWith(`requested:${profileId}:`) || [`lastReview:${profileId}`, `curated:${profileId}`, `curationSuggestions:${profileId}`].includes(row.key))
          this.db.prepare("DELETE FROM meta WHERE key=?").run(row.key);
    });
  }
  revokeVersion(profileId, skillId, versionHash, reason = "source_withdrawn") {
    this.ready(); transaction(this.db, () => {
      const skill = this.skill(skillId, profileId), row = this.db.prepare("SELECT data FROM versions WHERE skill_id=? AND hash=?").get(skillId, versionHash);
      if (!row) return;
      const version = parse(row);
      this.db.prepare("UPDATE versions SET revoked=1,data=? WHERE skill_id=? AND hash=?")
        .run(JSON.stringify({ ...version, title: "", description: "", reason, files: [] }), skillId, versionHash);
      if (skill.head === versionHash && !skill.revoked) {
        const updated = { ...skill, title: "", description: "", revoked: true, archived: true, revision: skill.revision + 1, updatedAt: this.now() };
        this.db.prepare("UPDATE skills SET revision=?,data=? WHERE id=?").run(updated.revision, JSON.stringify(updated), skillId);
        this._receipt(updated, skill.head, "withdraw", "source_policy", reason);
      }
      for (const row of this.db.prepare("SELECT data FROM jobs WHERE profile_id=? AND json_extract(data,'$.resultSkillId')=?").all(profileId, skillId)) {
        const job = parse(row); this._writeJob({ ...job, proposal: null, reason, state: "withdrawn", revision: job.revision + 1, updatedAt: this.now() });
      }
      for (const row of this.db.prepare("SELECT id,data FROM receipts WHERE profile_id=? AND skill_id=?").all(profileId, skillId))
        this.db.prepare("UPDATE receipts SET data=? WHERE id=?").run(JSON.stringify({ ...parse(row), reason }), row.id);
    });
    // The tombstone commits first. Read/revert is denied even if physical cleanup fails.
    try { this._removePackage(profileId, skillId, versionHash); }
    catch { this.setMeta("cleanupPending", true); }
  }
  _removePackage(profileId, skillId, versionHash) {
    const root = this._versionRoot(profileId, skillId, versionHash);
    if (!fs.existsSync(root)) return;
    validateCanonicalOwnedDirectory(root, { trustedRoot: this.paths.trustedRoot });
    fs.rmSync(root, { recursive: true, force: true });
    fsyncPrivateParent(path.dirname(root));
  }
  cleanupPackages() {
    this.ready(); let pending = false;
    for (const row of this.db.prepare("SELECT data FROM versions WHERE revoked=1").all()) {
      const version = parse(row);
      try { this._removePackage(version.profileId, version.skillId, version.hash); } catch { pending = true; }
    }
    // Failed CAS/publication may leave a complete, unreferenced immutable
    // package. Only our namespace is eligible, after a seven-day grace period.
    for (const row of this.db.prepare("SELECT profile_id FROM settings").all()) {
      if (!id(row.profile_id)) fail("LEARNING_STORE_CORRUPT");
      const root = path.join(this.paths.agentsDir, row.profile_id, "learned-skills");
      if (!fs.existsSync(root)) continue;
      try {
        validateCanonicalOwnedDirectory(root, { trustedRoot: this.paths.trustedRoot });
        for (const skill of fs.readdirSync(root, { withFileTypes: true })) {
          if (!/^skill-[a-f0-9]{40}$/u.test(skill.name) || !skill.isDirectory() || skill.isSymbolicLink()) continue;
          const versions = path.join(root, skill.name, "versions");
          if (!fs.existsSync(versions)) continue;
          validateCanonicalOwnedDirectory(versions, { trustedRoot: this.paths.trustedRoot });
          for (const entry of fs.readdirSync(versions, { withFileTypes: true })) {
            if (!hash(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
            if (this.db.prepare("SELECT 1 FROM versions WHERE skill_id=? AND hash=?").get(skill.name, entry.name)) continue;
            if (this.now() - fs.lstatSync(path.join(versions, entry.name)).mtimeMs < 7 * DAY_MS) continue;
            this._removePackage(row.profile_id, skill.name, entry.name);
          }
        }
      } catch { pending = true; }
    }
    this.setMeta("cleanupPending", pending);
  }
  restoreBarrier(barrier) {
    this.ready();
    const live = new Set((barrier?.liveVersions ?? []).map(item => `${item.profileId}:${item.skillId}:${item.hash}`));
    let withdrawn = 0;
    for (const row of this.db.prepare("SELECT data FROM versions WHERE revoked=0").all()) {
      const version = parse(row);
      if (live.has(`${version.profileId}:${version.skillId}:${version.hash}`)) continue;
      this.revokeVersion(version.profileId, version.skillId, version.hash, "restore_source_unverified"); withdrawn += 1;
    }
    transaction(this.db, () => {
      for (const row of this.db.prepare("SELECT data FROM settings").all()) {
        const settings = parse(row);
        const next = { ...settings, revision: settings.revision + 1, config: { ...settings.config, mode: "off" },
          consent: null, coverageStartedAt: this.now(), updatedAt: this.now() };
        this.db.prepare("UPDATE settings SET revision=?,data=? WHERE profile_id=?").run(next.revision, JSON.stringify(next), next.profileId);
      }
      for (const row of this.db.prepare("SELECT data FROM jobs").all()) {
        const job = parse(row), pending = ["queued", "reviewing", "validating", "pending_review"].includes(job.state);
        this._writeJob({ ...job, proposal: null, ...(pending ? { state: "interrupted", reason: "backup_restored" } : {}),
          revision: job.revision + 1, updatedAt: this.now() });
      }
      // Keep current cost/no-replay evidence; restoring an old snapshot never
      // restores consent or loses recorded usage.
      for (const row of barrier?.calls ?? []) {
        const old = this.db.prepare("SELECT charge FROM calls WHERE job_id=? AND attempt=?").get(row.job_id, row.attempt);
        if (!old || old.charge < row.charge) this.db.prepare("INSERT OR REPLACE INTO calls VALUES (?,?,?,?,?,?)")
          .run(row.job_id, row.attempt, row.profile_id, row.day, row.charge, row.data);
      }
      this.db.exec("DELETE FROM leases; DELETE FROM sources WHERE state='ready'; UPDATE notices SET delivered=1;");
    });
    this.cleanupPackages();
    return { consentReset: true, pendingJobsInterrupted: true, withdrawnVersions: withdrawn };
  }
  notices(limit = 20) { this.ready(); return this.db.prepare("SELECT data FROM notices WHERE delivered=0 ORDER BY created_at LIMIT ?").all(limit).map(parse); }
  acknowledgeNotice(noticeId) { this.ready(); this.db.prepare("UPDATE notices SET delivered=1 WHERE id=?").run(noticeId); }
  pruneLeases(activeRunIds) {
    this.ready(); for (const row of this.db.prepare("SELECT run_id FROM leases").all()) if (!activeRunIds.has(row.run_id)) this.db.prepare("DELETE FROM leases WHERE run_id=?").run(row.run_id);
  }
}
module.exports = { LearningStore, dayOf, validUsage };
