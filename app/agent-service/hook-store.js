"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { openDatabase, transaction } = require("./inspiration-database");
const { preparePrivateParent, fsyncPrivateParent, atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { HOOK_LIMITS, HOOK_EVENTS, id, fail, digest, safeJson, matches, dataAccess, validateDefinition } = require("./hook-contract");
const { projectHookMemoryEvent, projectHookMemoryOutput } = require("./hook-memory-projection");
const SCHEMA = [
  "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
  "CREATE TABLE hooks(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,owner TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER,epoch INTEGER NOT NULL,removed INTEGER NOT NULL,updated_at INTEGER NOT NULL,name TEXT NOT NULL);",
  "CREATE INDEX hooks_owner ON hooks(profile_id,id);",
  "CREATE TABLE versions(hook_id TEXT NOT NULL REFERENCES hooks(id),version INTEGER NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(hook_id,version));",
  "CREATE TABLE grants(hook_id TEXT NOT NULL,version INTEGER NOT NULL,incarnation TEXT NOT NULL,epoch INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(hook_id,version));",
  "CREATE TABLE operations(profile_id TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(profile_id,id));",
  "CREATE TABLE tests(profile_id TEXT NOT NULL,hook_id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(profile_id,hook_id,version));",
  "CREATE TABLE snapshots(id TEXT PRIMARY KEY,run_id TEXT UNIQUE,profile_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));",
  "CREATE TABLE executions(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,hook_id TEXT NOT NULL,version INTEGER NOT NULL,event_id TEXT NOT NULL,run_id TEXT,kind TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));",
  "CREATE INDEX executions_owner ON executions(profile_id,created_at DESC,id DESC);",
  "CREATE TABLE events(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,run_id TEXT,snapshot_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));",
  "PRAGMA user_version=1;",
].join("\n");
const parse = row => row ? JSON.parse(row.data) : null;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
function validateExecution(row) {
  const item = safeJson(parse(row));
  if (item.id !== row.id || !id(item.id) || item.profileId !== row.profile_id || !id(item.profileId)
    || item.hookId !== row.hook_id || !id(item.hookId) || item.version !== row.version || !Number.isSafeInteger(item.version) || item.version < 1 || item.version > 64
    || item.runId !== row.run_id || (item.runId !== null && !id(item.runId)) || item.eventId !== row.event_id || !id(item.eventId)
    || item.kind !== row.kind || !HOOK_EVENTS[item.event]?.includes(item.kind)
    || item.state !== row.state || item.createdAt !== row.created_at || !time(item.createdAt)
    || (item.finishedAt !== null && !time(item.finishedAt)) || !Number.isInteger(item.attempts) || item.attempts < 0 || item.attempts > 3
    || !["intent", "dispatched", "settled", "failed", "interrupted", "needs_verification"].includes(item.state)
    || !hash(item.inputDigest) || (item.outputDigest !== null && !hash(item.outputDigest))
    || (item.errorCode !== null && (typeof item.errorCode !== "string" || item.errorCode.length > 128))
    || (item.workerPid !== undefined && (!Number.isSafeInteger(item.workerPid) || item.workerPid < 1
      || typeof item.workerStartIdentity !== "string" || !item.workerStartIdentity || item.workerStartIdentity.length > 256))) fail("HOOK_STORE_CORRUPT");
  return item;
}
class HookStore {
  constructor({ paths, now = Date.now, randomUUID = crypto.randomUUID, database = openDatabase }) {
    this.paths = paths; this.now = now; this.randomUUID = randomUUID; this.database = database;
    this.dir = paths.hooksDir || path.join(paths.stateDir, "hooks");
    this.filePath = paths.hookDatabasePath || path.join(this.dir, "hooks.sqlite"); this.db = null;
  }
  open() {
    if (this.db) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot);
    const lease = acquirePrivateWriterLease({ lockPath: path.join(this.dir, "writer.lock"), trustedRoot: this.paths.trustedRoot });
    try {
      const db = this.database(this.filePath); this.db = db; this.lease = lease;
      const version = db.prepare("PRAGMA user_version").get().user_version;
      if (version === 0) transaction(db, () => {
        db.exec(SCHEMA); db.prepare("INSERT INTO meta VALUES('incarnation',?)").run(this.randomUUID());
      });
      else if (version !== 1) fail("HOOK_STORE_CORRUPT");
      if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("HOOK_STORE_CORRUPT");
      this.incarnation = db.prepare("SELECT value FROM meta WHERE key='incarnation'").get()?.value;
      if (!id(this.incarnation)) fail("HOOK_STORE_CORRUPT");
      this.validateStore();
      transaction(db, () => {
        for (const row of db.prepare("SELECT * FROM executions WHERE state='dispatched'").all()) {
          const item = parse(row);
          item.state = item.kind === "action" ? "needs_verification" : "interrupted";
          item.errorCode = "HOOK_EXECUTION_INTERRUPTED"; item.finishedAt = this.now();
          this.putExecution(item);
        }
      });
      fsyncPrivateParent(this.dir); this.poisoned = false; this.poisonError = null; return this;
    } catch (error) { this.db?.close(); this.db = null; this.lease = null; lease.release(); throw error; }
  }
  close() {
    try { if (this.db) { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { this.db.close(); } } }
    finally { this.db = null; this.lease?.release(); this.lease = null; }
  }
  ready() { if (!this.db || !this.lease || this.poisoned) fail("HOOK_UNAVAILABLE"); }
  validateStore() {
    try {
      for (const [table, maximum] of [["hooks", HOOK_LIMITS.total], ["versions", HOOK_LIMITS.total * 64],
        ["grants", HOOK_LIMITS.total * 64], ["tests", HOOK_LIMITS.total * 64], ["meta", 65537],
        ["operations", 65536], ["snapshots", 65536], ["executions", 65536], ["events", 65536]]) {
        if (this.db.prepare("SELECT count(*) AS n FROM " + table).get().n > maximum) fail("HOOK_STORE_CORRUPT");
      }
      for (const row of this.db.prepare("SELECT * FROM meta").all()) {
        if (row.key === "incarnation") { if (row.value !== this.incarnation) fail("HOOK_STORE_CORRUPT"); }
        else if (!row.key.startsWith("terminal:") || !id(row.key.slice(9)) || !/^\d{1,16}$/u.test(row.value) || !time(Number(row.value))) fail("HOOK_STORE_CORRUPT");
      }
      const hooks = new Map(this.db.prepare("SELECT * FROM hooks").all().map(row => {
        if (!id(row.id) || !id(row.profile_id) || row.owner !== "profile" || !Number.isSafeInteger(row.revision)
          || row.revision < 1 || !Number.isSafeInteger(row.epoch) || row.epoch < 0
          || ![0, 1].includes(row.removed) || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0) fail("HOOK_STORE_CORRUPT");
        return [row.id, row];
      }));
      const versions = new Map();
      for (const row of this.db.prepare("SELECT * FROM versions").all()) {
        const definition = safeJson(parse(row), HOOK_LIMITS.scriptBytes + HOOK_LIMITS.inputBytes);
        const scope = definition.scope;
        const checked = validateDefinition({ ...definition, scope: { ...scope, workspace: scope.workspace === null ? "profile" : "current" } }, scope.workspace);
        if (digest(checked) !== row.digest || digest(definition) !== row.digest || !hooks.has(row.hook_id)
          || !Number.isSafeInteger(row.version) || row.version < 1 || row.version > 64) fail("HOOK_STORE_CORRUPT");
        versions.set(row.hook_id + ":" + row.version, { contentDigest: row.digest, definition });
      }
      for (const row of hooks.values()) if (row.active !== null && (row.removed || !versions.has(row.id + ":" + row.active))) fail("HOOK_STORE_CORRUPT");
      for (const row of this.db.prepare("SELECT * FROM grants").all()) {
        if (!hooks.has(row.hook_id) || !id(row.incarnation) || !Number.isSafeInteger(row.epoch) || row.epoch < 0
          || digest(safeJson(parse(row))) !== digest({ ...dataAccess(versions.get(row.hook_id + ":" + row.version)?.definition || {}),
            contentDigest: versions.get(row.hook_id + ":" + row.version)?.contentDigest })) fail("HOOK_STORE_CORRUPT");
      }
      for (const row of this.db.prepare("SELECT * FROM operations").all()) {
        if (!id(row.profile_id) || !id(row.id) || !hash(row.fingerprint)) fail("HOOK_STORE_CORRUPT");
        safeJson(JSON.parse(row.result), HOOK_LIMITS.scriptBytes + HOOK_LIMITS.inputBytes);
      }
      for (const row of this.db.prepare("SELECT * FROM tests").all()) {
        const item = safeJson(parse(row)), record = versions.get(row.hook_id + ":" + row.version);
        if (hooks.get(row.hook_id)?.profile_id !== row.profile_id || !record || item.contentDigest !== record.contentDigest
          || typeof item.passed !== "boolean" || !time(item.testedAt) || !id(item.incarnation)) fail("HOOK_STORE_CORRUPT");
      }
      for (const row of this.db.prepare("SELECT * FROM snapshots").all()) {
        const item = safeJson(parse(row), 65536);
        if (item.id !== row.id || !id(item.id) || item.runId !== row.run_id || (item.runId !== null && !id(item.runId))
          || item.profileId !== row.profile_id || !id(item.profileId) || !id(item.incarnation)
          || !time(item.createdAt) || !["chat", "cron", "kanban", "inspiration", "proactive", "compaction"].includes(item.source)
          || !(item.workspace === null || typeof item.workspace === "string" && path.isAbsolute(item.workspace) && path.normalize(item.workspace) === item.workspace)
          || !Array.isArray(item.entries) || item.entries.length > HOOK_LIMITS.perProfile) fail("HOOK_STORE_CORRUPT");
        for (const entry of item.entries) {
          if (!Number.isSafeInteger(entry.epoch) || entry.epoch < 0) fail("HOOK_STORE_CORRUPT");
          if (entry.owner === "plugin") {
            const ref = entry.pluginRef;
            if (!ref || ref.profileId !== item.profileId || !id(ref.installationId) || !hash(ref.releaseDigest) || !hash(ref.componentId)
              || !hash(ref.descriptorDigest) || !hash(ref.grantDigest) || !hash(ref.authorityIncarnation) || !hash(entry.contentDigest)
              || !id(ref.bindingId) || !Number.isSafeInteger(ref.bindingRevision) || ref.bindingRevision < 1
              || !Number.isSafeInteger(ref.installationRevision) || ref.installationRevision < 1 || ref.epoch !== entry.epoch
              || !(ref.workspace === null || typeof ref.workspace === "string" && path.isAbsolute(ref.workspace))
              || typeof ref.sourceIdentity !== "string" || ref.sourceIdentity.length > 4096 || entry.version !== 1
              || entry.hookId !== "plugin-hook-" + digest([ref.profileId, ref.installationId, ref.releaseDigest, ref.componentId])) fail("HOOK_STORE_CORRUPT");
          } else if (entry.contentDigest !== versions.get(entry.hookId + ":" + entry.version)?.contentDigest
            || hooks.get(entry.hookId)?.profile_id !== item.profileId) fail("HOOK_STORE_CORRUPT");
        }
      }
      for (const row of this.db.prepare("SELECT * FROM executions").all()) {
        validateExecution(row);
      }
      for (const row of this.db.prepare("SELECT * FROM events").all()) {
        const item = safeJson(parse(row));
        if (item.eventId !== row.id || item.profileId !== row.profile_id || item.runId !== row.run_id
          || !["pending", "settled"].includes(row.state)
          || !this.db.prepare("SELECT id FROM snapshots WHERE id=? AND profile_id=?").get(row.snapshot_id, row.profile_id)) fail("HOOK_STORE_CORRUPT");
      }
    } catch { fail("HOOK_STORE_CORRUPT"); }
  }
  write(action) {
    this.ready();
    try { return transaction(this.db, () => {
      const result = action();
      if (this.db.prepare("PRAGMA page_count").get().page_count * this.db.prepare("PRAGMA page_size").get().page_size > HOOK_LIMITS.storeBytes) fail("HOOK_CAPACITY");
      return result;
    }); }
    catch (error) {
      // node:sqlite uses ERR_SQLITE_ERROR plus the SQLite numeric errcode;
      // better-sqlite3 uses symbolic codes. Fence both packaged engines.
      if (/^SQLITE_(IOERR|CORRUPT|NOTADB|FULL)/u.test(error.code || "")
        || Number.isInteger(error.errcode) && [10, 11, 13, 26].includes(error.errcode & 255)) {
        this.poisoned = true;
        this.poisonError ||= error;
      }
      throw error;
    }
  }
  operation(profileId, operationId, request, action) {
    if (!id(profileId) || !id(operationId)) fail();
    return this.write(() => {
      const fingerprint = digest(request);
      const prior = this.db.prepare("SELECT * FROM operations WHERE profile_id=? AND id=?").get(profileId, operationId);
      if (prior) { if (prior.fingerprint !== fingerprint) fail("HOOK_OPERATION_CONFLICT"); return JSON.parse(prior.result); }
      if (this.db.prepare("SELECT count(*) AS n FROM operations").get().n >= 65536) fail("HOOK_CAPACITY");
      const result = action();
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(profileId, operationId, fingerprint, JSON.stringify(result));
      return structuredClone(result);
    });
  }
  row(profileId, hookId, { mutable = false } = {}) {
    this.ready();
    const row = this.db.prepare("SELECT * FROM hooks WHERE id=? AND profile_id=?").get(hookId, profileId);
    if (!row || row.removed) fail("HOOK_NOT_FOUND");
    if (mutable && row.owner !== "profile") fail("HOOK_FORBIDDEN");
    return row;
  }
  version(hookId, version) {
    this.ready(); const row = this.db.prepare("SELECT * FROM versions WHERE hook_id=? AND version=?").get(hookId, version);
    if (!row) fail("HOOK_NOT_FOUND");
    return { definition: parse(row), contentDigest: row.digest };
  }
  get(profileId, hookId, version) {
    const row = this.row(profileId, hookId);
    const selected = version ?? this.db.prepare("SELECT max(version) AS version FROM versions WHERE hook_id=?").get(hookId).version;
    const record = this.version(hookId, selected);
    return { hookId, profileId, owner: row.owner, revision: row.revision, version: selected,
      activeVersion: row.active, epoch: row.epoch, updatedAt: row.updated_at, ...record };
  }
  list(profileId, { cursor = "", limit = HOOK_LIMITS.pageSize, event, enabled } = {}) {
    this.ready();
    if (!id(profileId) || typeof cursor !== "string" || cursor && !id(cursor)
      || !Number.isInteger(limit) || limit < 1 || limit > HOOK_LIMITS.pageSize) fail();
    const rows = this.db.prepare("SELECT * FROM hooks WHERE profile_id=? AND removed=0 AND id>? ORDER BY id").all(profileId, cursor)
      .filter(row => enabled === undefined || (row.active !== null) === enabled)
      .filter(row => event === undefined || this.get(profileId, row.id, row.active ?? undefined).definition.event === event);
    const items = rows.slice(0, limit).map(row => this.get(profileId, row.id));
    return { items, nextCursor: rows.length > limit ? items.at(-1).hookId : null };
  }
  saveSource(definition) {
    if (definition.handler.type !== "script") return;
    const scriptDigest = digest(definition.handler.source);
    const extension = definition.handler.language === "javascript" ? "cjs" : "py";
    const file = path.join(this.dir, "packages", scriptDigest, "handler." + extension);
    try {
      const prior = readPrivateFile(file, { maxBytes: HOOK_LIMITS.scriptBytes }).toString("utf8");
      if (prior !== definition.handler.source) fail("HOOK_SOURCE_CHANGED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const packages = path.join(this.dir, "packages");
      const directories = fs.existsSync(packages) ? fs.readdirSync(packages) : [];
      if (directories.length >= HOOK_LIMITS.scriptPackages) fail("HOOK_CAPACITY");
      let bytes = 0;
      for (const name of directories) {
        if (!/^[a-f0-9]{64}$/u.test(name)) fail("HOOK_STORE_CORRUPT");
        if (fs.realpathSync(path.join(packages, name)) !== path.join(packages, name)) fail("HOOK_STORE_CORRUPT");
        for (const packageFile of fs.readdirSync(path.join(packages, name))) {
          if (!["handler.cjs", "handler.py"].includes(packageFile)) fail("HOOK_STORE_CORRUPT");
          bytes += readPrivateFile(path.join(packages, name, packageFile), { maxBytes: HOOK_LIMITS.scriptBytes }).length;
        }
      }
      if (bytes + Buffer.byteLength(definition.handler.source) > HOOK_LIMITS.scriptStoreBytes) fail("HOOK_CAPACITY");
      atomicWritePrivateFile(file, definition.handler.source, { trustedRoot: this.paths.trustedRoot });
    }
  }
  sourcePath(definition) {
    const extension = definition.handler.language === "javascript" ? "cjs" : "py";
    const file = path.join(this.dir, "packages", digest(definition.handler.source), "handler." + extension);
    if (readPrivateFile(file, { maxBytes: HOOK_LIMITS.scriptBytes }).toString("utf8") !== definition.handler.source) fail("HOOK_SOURCE_CHANGED");
    return file;
  }
  register(profileId, operationId, definition) {
    return this.operation(profileId, operationId, { kind: "register", definition }, () => {
      if (this.db.prepare("SELECT count(*) AS n FROM hooks WHERE profile_id=? AND removed=0").get(profileId).n >= HOOK_LIMITS.perProfile
        || this.db.prepare("SELECT count(*) AS n FROM hooks").get().n >= HOOK_LIMITS.total) fail("HOOK_CAPACITY");
      this.saveSource(definition);
      const hookId = "hook-" + this.randomUUID();
      this.db.prepare("INSERT INTO hooks VALUES(?,?,?,1,NULL,0,0,?,?)").run(hookId, profileId, "profile", this.now(), definition.name);
      this.db.prepare("INSERT INTO versions VALUES(?,?,?,?)").run(hookId, 1, digest(definition), JSON.stringify(definition));
      return this.get(profileId, hookId);
    });
  }
  update(profileId, operationId, hookId, expectedRevision, definition) {
    return this.operation(profileId, operationId, { kind: "update", hookId, expectedRevision, definition }, () => {
      const row = this.row(profileId, hookId, { mutable: true });
      if (row.revision !== expectedRevision) fail("HOOK_REVISION_CONFLICT");
      const latest = this.get(profileId, hookId).version;
      if (latest >= 64) fail("HOOK_CAPACITY");
      this.saveSource(definition);
      const version = latest + 1;
      this.db.prepare("INSERT INTO versions VALUES(?,?,?,?)").run(hookId, version, digest(definition), JSON.stringify(definition));
      this.db.prepare("UPDATE hooks SET revision=revision+1,updated_at=?,name=? WHERE id=?").run(this.now(), definition.name, hookId);
      return this.get(profileId, hookId);
    });
  }
  grant(profileId, operationId, hookId, version) {
    return this.operation(profileId, operationId, { kind: "grant", hookId, version }, () => {
      const row = this.row(profileId, hookId, { mutable: true });
      const record = this.version(hookId, version);
      const grant = { ...dataAccess(record.definition), contentDigest: record.contentDigest };
      this.db.prepare("INSERT INTO grants VALUES(?,?,?,?,?) ON CONFLICT(hook_id,version) DO UPDATE SET incarnation=excluded.incarnation,epoch=excluded.epoch,data=excluded.data")
        .run(hookId, version, this.incarnation, row.epoch, JSON.stringify(grant));
      return { hookId, version, granted: true, grant };
    });
  }
  isGranted(hookId, version, epoch, definition) {
    const access = dataAccess(definition);
    if (definition.handler.type === "builtin" && !Object.values(access).some(Boolean)) return true;
    const row = this.db.prepare("SELECT * FROM grants WHERE hook_id=? AND version=?").get(hookId, version);
    return row?.incarnation === this.incarnation && row.epoch === epoch
      && parse(row)?.contentDigest === digest(definition);
  }
  activate(profileId, operationId, hookId, version, expectedRevision, assertSupported) {
    return this.operation(profileId, operationId, { kind: "enable", hookId, version, expectedRevision }, () => {
      const row = this.row(profileId, hookId, { mutable: true });
      if (row.revision !== expectedRevision) fail("HOOK_REVISION_CONFLICT");
      const { definition } = this.version(hookId, version);
      assertSupported(definition);
      if (!this.isGranted(hookId, version, row.epoch, definition)) fail("HOOK_GRANT_REQUIRED");
      this.db.prepare("UPDATE hooks SET active=?,revision=revision+1,updated_at=? WHERE id=?").run(version, this.now(), hookId);
      return { ...this.get(profileId, hookId, version), effectiveFrom: "next_run" };
    });
  }
  disable(profileId, operationId, hookId, expectedRevision, remove = false) {
    return this.operation(profileId, operationId, { kind: remove ? "remove" : "disable", hookId, expectedRevision }, () => {
      const row = this.row(profileId, hookId, { mutable: true });
      if (row.revision !== expectedRevision) fail("HOOK_REVISION_CONFLICT");
      this.db.prepare("UPDATE hooks SET active=NULL,revision=revision+1,epoch=epoch+1,removed=?,updated_at=? WHERE id=?").run(Number(remove), this.now(), hookId);
      return { hookId, revision: row.revision + 1, disabled: true, removed: remove, effectiveFrom: "immediate", epoch: row.epoch + 1 };
    });
  }
  freeze(run, capabilities, assertSupported, { onlyEvent = null } = {}) {
    this.ready();
    const prior = this.snapshotForRun(run.id);
    if (prior) {
      if (prior.profileId !== run.profileId || prior.workspace !== run.workspace || prior.source !== run.source) fail("HOOK_SNAPSHOT_CONFLICT");
      for (const item of prior.entries) { assertSupported(item.definition); this.assertCurrent(prior, item); }
      return prior;
    }
    let entries = ["compaction", "proactive"].includes(run.source) ? [] : this.db.prepare("SELECT * FROM hooks WHERE profile_id=? AND active IS NOT NULL AND removed=0 ORDER BY id")
      .all(run.profileId).map(row => ({ ...this.version(row.id, row.active), hookId: row.id, version: row.active, epoch: row.epoch }))
      .filter(item => item.definition.scope.sources.includes(run.source) && (item.definition.scope.workspace === null || item.definition.scope.workspace === run.workspace))
      .filter(item => onlyEvent === null || item.definition.kind === "observe" && item.definition.event === onlyEvent)
      .filter(item => onlyEvent === null || this.row(run.profileId, item.hookId).updated_at <= run.finishedAt);
    if (!["compaction", "proactive"].includes(run.source)) entries.push(...(this.pluginHooks?.entriesForRun(run) || [])
      .filter(item => onlyEvent === null || item.definition.kind === "observe" && item.definition.event === onlyEvent && item.activatedAt <= run.finishedAt));
    if (entries.length > HOOK_LIMITS.perProfile) fail("HOOK_CAPACITY");
    for (const item of entries) {
      assertSupported(item.definition);
      if (item.owner === "plugin") this.pluginHooks.assertCurrent({ profileId: run.profileId }, item);
      else if (!this.isGranted(item.hookId, item.version, item.epoch, item.definition)) fail("HOOK_GRANT_REQUIRED");
    }
    const snapshot = { id: "hook-snapshot-" + this.randomUUID(), runId: run.id, profileId: run.profileId, createdAt: this.now(),
      workspace: run.workspace, source: run.source, incarnation: this.incarnation, capabilities, entries };
    return this.write(() => {
      if (this.db.prepare("SELECT count(*) AS n FROM snapshots").get().n >= 65536) fail("HOOK_CAPACITY");
      this.putSnapshot(snapshot);
      return structuredClone(snapshot);
    });
  }
  putSnapshot(snapshot) {
    const material = { ...snapshot, entries: snapshot.entries.map(({ definition, sourceFile, ...entry }) => entry) };
    this.db.prepare("INSERT INTO snapshots VALUES(?,?,?,?)").run(snapshot.id, snapshot.runId, snapshot.profileId, JSON.stringify(material));
  }
  hydrate(snapshot, { skipUnavailablePlugins = false, onSkipped = () => {} } = {}) {
    if (!snapshot) return null;
    return { ...snapshot, entries: snapshot.entries.map(entry => {
      if (entry.owner === "plugin") {
        try {
          if (!this.pluginHooks) fail("HOOK_PLUGIN_UNAVAILABLE");
          return this.pluginHooks.hydrate(entry, snapshot);
        } catch (error) {
          // Only the durable observer outbox may discard an unavailable
          // immutable package. Mandatory Run hydration still fails closed.
          if (!skipUnavailablePlugins || error.code === "HOOK_STORE_CORRUPT") throw error;
          onSkipped(entry, error); return null;
        }
      }
      const record = this.version(entry.hookId, entry.version);
      if (record.contentDigest !== entry.contentDigest) fail("HOOK_STORE_CORRUPT");
      return { ...entry, definition: record.definition };
    }).filter(Boolean) };
  }
  snapshotForRun(runId) { this.ready(); return this.hydrate(parse(this.db.prepare("SELECT data FROM snapshots WHERE run_id=?").get(runId))); }
  freezeSession(session, event, eventId, capabilities) {
    this.ready();
    const snapshotId = "hook-snapshot-" + digest([session.profileId, session.sessionKey, eventId]);
    const prior = parse(this.db.prepare("SELECT data FROM snapshots WHERE id=?").get(snapshotId));
    if (prior) return this.hydrate(prior);
    const entries = this.db.prepare("SELECT * FROM hooks WHERE profile_id=? AND active IS NOT NULL AND removed=0 ORDER BY id")
      .all(session.profileId)
      .filter(row => event !== "session.created" || row.updated_at <= session.createdAt)
      .filter(row => event !== "session.closed" || row.updated_at <= session.updatedAt)
      .map(row => ({ ...this.version(row.id, row.active), hookId: row.id, version: row.active, epoch: row.epoch }))
      .filter(entry => entry.definition.kind === "observe" && entry.definition.event === event
        && entry.definition.scope.sources.includes("chat")
        && (entry.definition.scope.workspace === null || entry.definition.scope.workspace === session.workspace));
    entries.push(...(this.pluginHooks?.entriesForRun({ profileId: session.profileId, workspace: session.workspace, source: "chat" }) || [])
      .filter(item => item.definition.kind === "observe" && item.definition.event === event
        && (event !== "session.created" || item.activatedAt <= session.createdAt)
        && (event !== "session.closed" || item.activatedAt <= session.updatedAt)));
    if (entries.length > HOOK_LIMITS.perProfile) fail("HOOK_CAPACITY");
    const snapshot = { id: snapshotId, runId: null, profileId: session.profileId, workspace: session.workspace,
      source: "chat", incarnation: this.incarnation, createdAt: this.now(), capabilities, entries };
    return this.write(() => { this.putSnapshot(snapshot); return snapshot; });
  }
  assertCurrent(snapshot, entry) {
    this.ready();
    if (entry.owner === "plugin") {
      if (snapshot.incarnation !== this.incarnation || !this.pluginHooks) fail("HOOK_REVOKED");
      return this.pluginHooks.assertCurrent(snapshot, entry);
    }
    const row = this.db.prepare("SELECT * FROM hooks WHERE id=?").get(entry.hookId);
    if (snapshot.incarnation !== this.incarnation || !row || row.removed || row.active === null
      || row.profile_id !== snapshot.profileId || row.epoch !== entry.epoch
      || !this.isGranted(entry.hookId, entry.version, entry.epoch, entry.definition)) fail("HOOK_REVOKED");
  }
  select(snapshot, event, kind) {
    return snapshot.entries.filter(entry => (!kind || entry.definition.kind === kind) && matches(entry.definition, event))
      .sort((left, right) => right.definition.priority - left.definition.priority || left.hookId.localeCompare(right.hookId));
  }
  beginExecution(snapshot, entry, event) {
    const executionId = "hook-exec-" + digest([snapshot.id, entry.hookId, entry.version, event.eventId]);
    return this.write(() => {
      const prior = parse(this.db.prepare("SELECT data FROM executions WHERE id=?").get(executionId));
      if (prior) {
        if (prior.inputDigest !== digest(event)) fail("HOOK_EXECUTION_CONFLICT");
        return { execution: prior, fresh: false };
      }
      if (this.db.prepare("SELECT count(*) AS n FROM executions").get().n >= 65536) fail("HOOK_CAPACITY");
      const execution = { id: executionId, profileId: snapshot.profileId, hookId: entry.hookId, version: entry.version,
        eventId: event.eventId, event: event.event, runId: event.runId ?? null, kind: entry.definition.kind,
        state: "intent", inputDigest: digest(event), createdAt: this.now(), finishedAt: null,
        errorCode: null, output: null, outputDigest: null, attempts: 0 };
      this.putExecution(execution); return { execution, fresh: true };
    });
  }
  putExecution(item) {
    if (item.persistPolicy === "reference_only" && item.output !== null) item = { ...item, output: projectHookMemoryOutput(item.output, item.borrowedMemoryRefs || [], true) };
    this.db.prepare("INSERT INTO executions VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data")
      .run(item.id, item.profileId, item.hookId, item.version, item.eventId, item.runId, item.kind, item.state, item.createdAt, JSON.stringify(item));
  }
  settleExecution(item, patch) { return this.write(() => { const updated = { ...item, ...patch }; this.putExecution(updated); return updated; }); }
  executions(profileId, { cursor = "", limit = HOOK_LIMITS.pageSize, hookId, runId } = {}) {
    this.ready(); if (!id(profileId) || !Number.isInteger(limit) || limit < 1 || limit > HOOK_LIMITS.pageSize
      || cursor && !id(cursor) || hookId !== undefined && !id(hookId) || runId !== undefined && !id(runId)) fail();
    const clauses = ["profile_id=?", "id>?"];
    const params = [profileId, cursor];
    if (hookId !== undefined) { clauses.push("hook_id=?"); params.push(hookId); }
    if (runId !== undefined) { clauses.push("run_id=?"); params.push(runId); }
    const rows = this.db.prepare("SELECT data FROM executions WHERE " + clauses.join(" AND ") + " ORDER BY id LIMIT ?")
      .all(...params, limit + 1).map(parse);
    const items = rows.slice(0, limit).map(({ output, ...item }) => item);
    return { items, nextCursor: rows.length > limit ? items.at(-1).id : null };
  }
  execution(profileId, executionId) {
    this.ready(); const item = parse(this.db.prepare("SELECT data FROM executions WHERE profile_id=? AND id=?").get(profileId, executionId));
    if (!item) fail("HOOK_NOT_FOUND"); return item;
  }
  recordTest(profileId, hookId, version, contentDigest, passed) {
    this.row(profileId, hookId);
    return this.write(() => this.db.prepare("INSERT INTO tests VALUES(?,?,?,?) ON CONFLICT(profile_id,hook_id,version) DO UPDATE SET data=excluded.data")
      .run(profileId, hookId, version, JSON.stringify({ passed, contentDigest, testedAt: this.now(), incarnation: this.incarnation })));
  }
  latestTest(profileId, hookId, version) {
    this.ready(); const receipt = parse(this.db.prepare("SELECT data FROM tests WHERE profile_id=? AND hook_id=? AND version=?").get(profileId, hookId, version));
    return receipt?.incarnation === this.incarnation ? receipt : null;
  }
  enqueueEvent(snapshot, event) {
    event = projectHookMemoryEvent(event);
    return this.write(() => {
      const prior = this.db.prepare("SELECT * FROM events WHERE id=?").get(event.eventId);
      if (prior) { if (prior.data !== JSON.stringify(event) || prior.snapshot_id !== snapshot.id) fail("HOOK_EXECUTION_CONFLICT"); return false; }
      if (this.db.prepare("SELECT count(*) AS n FROM events WHERE state='pending'").get().n >= HOOK_LIMITS.queue) fail("HOOK_CAPACITY");
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)").run(event.eventId, snapshot.profileId, event.runId ?? null, snapshot.id, "pending", JSON.stringify(event)); return true;
    });
  }
  pendingEvents() {
    this.ready();
    return this.db.prepare("SELECT events.*,snapshots.data AS snapshot FROM events JOIN snapshots ON events.snapshot_id=snapshots.id WHERE events.state='pending' LIMIT 1024")
      .all().map(row => ({ event: parse(row), snapshot: JSON.parse(row.snapshot) }));
  }
  finishEvent(eventId) { this.write(() => this.db.prepare("UPDATE events SET state='settled' WHERE id=?").run(eventId)); }
  workersForRecovery() {
    this.ready();
    return this.db.prepare("SELECT data FROM executions WHERE state IN ('needs_verification','interrupted','failed')").all()
      .map(parse).filter(item => Number.isSafeInteger(item.workerPid) && item.workerPid > 0 && typeof item.workerStartIdentity === "string");
  }
  markTerminal(runId) {
    if (!id(runId)) fail("HOOK_AUTHORITY_INVALID");
    this.write(() => this.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO NOTHING")
      .run("terminal:" + runId, String(this.now())));
  }
  rotateAuthority() {
    this.write(() => {
      this.incarnation = this.randomUUID(); this.db.prepare("UPDATE meta SET value=? WHERE key='incarnation'").run(this.incarnation);
      this.db.prepare("DELETE FROM grants").run();
      this.db.prepare("UPDATE hooks SET active=NULL,revision=revision+1,epoch=epoch+1").run();
    });
  }
  restoreReplayBarrier(items = []) {
    if (!Array.isArray(items) || items.length > 65536) fail("HOOK_STORE_CORRUPT");
    this.write(() => {
      for (const item of items) {
        validateExecution({ id: item.id, profile_id: item.profileId, hook_id: item.hookId, version: item.version,
          event_id: item.eventId, run_id: item.runId, kind: item.kind, state: item.state, created_at: item.createdAt, data: JSON.stringify(item) });
        if (item.kind !== "action" || !["dispatched", "needs_verification"].includes(item.state)) fail("HOOK_STORE_CORRUPT");
        const existing = parse(this.db.prepare("SELECT data FROM executions WHERE id=?").get(item.id));
        if (existing && existing.inputDigest !== item.inputDigest) fail("HOOK_STORE_CORRUPT");
        this.putExecution({ ...item, state: "needs_verification", output: null, errorCode: "HOOK_NEEDS_VERIFICATION" });
      }
    });
  }
  pauseProfile(profileId) { this.write(() => this.db.prepare("UPDATE hooks SET active=NULL,revision=revision+1,epoch=epoch+1 WHERE profile_id=?").run(profileId)); }
  purgeProfile(profileId) {
    this.write(() => {
      this.db.prepare("UPDATE hooks SET active=NULL,revision=revision+1,epoch=epoch+1,removed=1 WHERE profile_id=?").run(profileId);
      for (const row of this.db.prepare("SELECT * FROM executions WHERE profile_id=? AND kind='action' AND state='dispatched'").all(profileId)) {
        this.putExecution({ ...parse(row), state: "needs_verification", output: null, errorCode: "HOOK_NEEDS_VERIFICATION", finishedAt: this.now() });
      }
      // Keep unknown side-effect tombstones; never erase them to make capacity.
      this.db.prepare("DELETE FROM executions WHERE profile_id=? AND state!='needs_verification'").run(profileId);
      this.db.prepare("DELETE FROM operations WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM events WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM snapshots WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM tests WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM grants WHERE hook_id IN (SELECT id FROM hooks WHERE profile_id=?)").run(profileId);
      this.db.prepare("DELETE FROM versions WHERE hook_id IN (SELECT id FROM hooks WHERE profile_id=?)").run(profileId);
      this.db.prepare("UPDATE hooks SET name='removed' WHERE profile_id=?").run(profileId);
    });
    this.collectSources();
  }
  collectSources() {
    const used = new Set(this.db.prepare("SELECT data FROM versions").all().map(parse)
      .filter(item => item.handler.type === "script").map(item => digest(item.handler.source)));
    const packages = path.join(this.dir, "packages");
    if (!fs.existsSync(packages)) return;
    for (const name of fs.readdirSync(packages)) {
      const target = path.join(packages, name);
      if (!/^[a-f0-9]{64}$/u.test(name) || fs.realpathSync(target) !== target) fail("HOOK_STORE_CORRUPT");
      if (used.has(name)) continue;
      for (const file of fs.readdirSync(target)) {
        if (!["handler.cjs", "handler.py"].includes(file)) fail("HOOK_STORE_CORRUPT");
        readPrivateFile(path.join(target, file), { maxBytes: HOOK_LIMITS.scriptBytes });
        fs.unlinkSync(path.join(target, file));
      }
      fs.rmdirSync(target);
    }
  }
  prune() {
    const cutoff = this.now() - HOOK_LIMITS.retentionMs;
    this.write(() => {
      this.db.prepare("DELETE FROM executions WHERE state IN ('settled','failed','interrupted') AND created_at<? AND ((run_id IN (SELECT substr(key,10) FROM meta WHERE key LIKE 'terminal:%' AND CAST(value AS INTEGER)<?) AND NOT EXISTS (SELECT 1 FROM events WHERE events.run_id=executions.run_id AND state='pending')) OR (run_id IS NULL AND event_id IN (SELECT id FROM events WHERE state='settled' AND snapshot_id IN (SELECT id FROM snapshots WHERE run_id IS NULL AND json_extract(data,'$.createdAt')<?))))").run(cutoff, cutoff, cutoff);
      const finished = this.db.prepare("SELECT key FROM meta WHERE key LIKE 'terminal:%' AND CAST(value AS INTEGER)<?").all(cutoff);
      for (const item of finished) {
        const runId = item.key.slice(9);
        if (this.db.prepare("SELECT id FROM executions WHERE run_id=? AND state IN ('intent','dispatched','needs_verification') LIMIT 1").get(runId)
          || this.db.prepare("SELECT id FROM events WHERE run_id=? AND state='pending' LIMIT 1").get(runId)) continue;
        this.db.prepare("DELETE FROM events WHERE run_id=?").run(runId);
        this.db.prepare("DELETE FROM snapshots WHERE run_id=?").run(runId);
        this.db.prepare("DELETE FROM meta WHERE key=?").run(item.key);
      }
      this.db.prepare("DELETE FROM events WHERE state='settled' AND run_id IS NULL AND snapshot_id IN (SELECT id FROM snapshots WHERE json_extract(data,'$.createdAt')<?)").run(cutoff);
      this.db.prepare("DELETE FROM snapshots WHERE run_id IS NULL AND json_extract(data,'$.createdAt')<? AND NOT EXISTS (SELECT 1 FROM events WHERE events.snapshot_id=snapshots.id)").run(cutoff);
    });
  }
}
function readHookReplayBarrier(paths) {
  const file = paths.hookDatabasePath || path.join(paths.stateDir, "hooks", "hooks.sqlite");
  if (!fs.existsSync(file)) return [];
  const db = openDatabase(file, { readOnly: true });
  try {
    if (db.prepare("PRAGMA user_version").get().user_version !== 1 || db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("HOOK_STORE_CORRUPT");
    return db.prepare("SELECT * FROM executions WHERE kind='action' AND state IN ('dispatched','needs_verification') LIMIT 65537").all()
      .map(validateExecution);
  } finally { db.close(); }
}
module.exports = { HookStore, HOOK_DATABASE_SCHEMA: SCHEMA, readHookReplayBarrier };
