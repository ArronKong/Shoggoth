"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setImmediate: nextTick } = require("node:timers/promises");
const { openDatabase, transaction } = require("./inspiration-database");
const { ensurePrivateDirectoryTree, serviceError, validatePrivateFileStat } = require("./security");

const SCHEMA_VERSION = 4;
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, revision INTEGER NOT NULL,
  last_seq INTEGER NOT NULL, source_identity TEXT,
  workspace TEXT, status TEXT NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL,
  kind TEXT NOT NULL, occurred_at INTEGER NOT NULL, content_hash TEXT NOT NULL,
  search_text TEXT NOT NULL, search_terms TEXT NOT NULL, UNIQUE(session_id, event_id)
);
CREATE INDEX events_session ON events(session_id, seq);
CREATE VIRTUAL TABLE events_fts USING fts5(
  search_terms, content='events', content_rowid='id', tokenize="unicode61 tokenchars '-_'"
);
CREATE TRIGGER events_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid,search_terms) VALUES(new.id,new.search_terms);
END;
CREATE TRIGGER events_delete AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts,rowid,search_terms) VALUES('delete',old.id,old.search_terms);
END;
`;

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function lexicalTerms(text) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const segments = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) || [];
  const terms = [];
  for (const segment of segments) {
    if (!/\p{Script=Han}/u.test(segment)) terms.push(segment);
    else {
      const characters = [...segment];
      if (characters.length === 1) terms.push(segment);
      else for (let i = 0; i < characters.length - 1; i += 1) {
        terms.push(characters[i] + characters[i + 1]);
      }
    }
  }
  return [...new Set(terms)];
}

function indexError(cause) {
  const error = serviceError("CONVERSATION_INDEX_UNAVAILABLE", "会话搜索索引不可用，请稍后重试");
  error.cause = cause;
  return error;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

// SQLite is a derived index. Its rows are never returned to the model without
// loading the current event from TranscriptStore and rechecking visibility.
class ConversationRecallIndex {
  constructor({ paths }) {
    if (!paths?.agentsDir || !paths?.trustedRoot) throw new TypeError("ConversationRecallIndex paths 无效");
    this.paths = paths;
    this.connections = new Map();
    this.dataVersions = new Map();
    this.fileIdentities = new Map();
    this.builds = new Map();
    this.failures = new Map();
    this.cleanedProfiles = new Set();
  }

  close() {
    for (const job of this.builds.values()) job.cancelled = true;
    this.builds.clear();
    let closeError = null;
    for (const db of this.connections.values()) {
      try { db.close(); } catch (error) { closeError ||= error; }
    }
    this.connections.clear();
    this.dataVersions.clear();
    this.fileIdentities.clear();
    this.failures.clear();
    this.cleanedProfiles.clear();
    if (closeError) throw indexError(closeError);
  }

  forgetProfile(profileId) {
    const job = this.builds.get(profileId);
    if (job) job.cancelled = true;
    this.builds.delete(profileId);
    const db = this.connections.get(profileId);
    this.connections.delete(profileId);
    this.dataVersions.delete(profileId);
    this.fileIdentities.delete(profileId);
    this.failures.delete(profileId);
    if (db) db.close();
  }

  // A revocation first removes this disposable plaintext index. The next
  // search rebuilds from the current transcript and recall-policy facts.
  invalidateProfile(profileId) {
    const ownBuildTemp = this.builds.get(profileId)?.temp ?? null;
    this.forgetProfile(profileId);
    const file = this._file(profileId);
    this._clearOrphanBuilds(profileId, ownBuildTemp);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const target = file + suffix;
      try {
        validatePrivateFileStat(fs.lstatSync(target), target);
        fs.unlinkSync(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw indexError(error);
      }
    }
    const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }

  _file(profileId) {
    if (!validId(profileId)) throw serviceError("CONVERSATION_INDEX_INVALID", "Profile 无效");
    const dir = path.join(this.paths.agentsDir, profileId);
    ensurePrivateDirectoryTree(dir, this.paths.trustedRoot);
    return path.join(dir, "conversation-recall.sqlite");
  }

  _clearOrphanBuilds(profileId, ownCancelledTemp = null) {
    const file = this._file(profileId);
    const dir = path.dirname(file);
    const buildName = /^conversation-recall\.sqlite\.building-([1-9]\d*)-[a-f0-9]{16}(?:-wal|-shm|-journal)?$/u;
    const ownName = ownCancelledTemp ? path.basename(ownCancelledTemp) : null;
    const deadProcesses = new Map();
    for (const entry of fs.readdirSync(dir)) {
      const match = buildName.exec(entry);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid)) continue;
      if (pid === process.pid) {
        // Revocation cancels this instance's build and erases its plaintext
        // temp immediately. A different index instance in this process may
        // still be building, so do not sweep all files with our PID.
        if (!ownName || !(entry === ownName || ["-wal", "-shm", "-journal"]
          .some((suffix) => entry === ownName + suffix))) continue;
      } else {
        if (!deadProcesses.has(pid)) {
          let dead = false;
          try { process.kill(pid, 0); }
          catch (error) { dead = error.code === "ESRCH"; }
          // EPERM and failed identity probes are ambiguous: preserve a possibly
          // active builder's private SQLite files rather than disrupting it.
          deadProcesses.set(pid, dead);
        }
        if (!deadProcesses.get(pid)) continue;
      }
      const target = path.join(dir, entry);
      try {
        validatePrivateFileStat(fs.lstatSync(target), target);
        fs.unlinkSync(target);
      } catch (error) { if (error.code !== "ENOENT") throw indexError(error); }
    }
    this.cleanedProfiles.add(profileId);
  }

  _meta(db, key) {
    return db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
  }

  _putMeta(db, key, value) {
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, String(value));
  }

  _dataVersion(db) {
    const value = db.prepare("PRAGMA data_version").get()?.data_version;
    if (!Number.isSafeInteger(value)) throw new Error("conversation index data version invalid");
    return value;
  }

  _privateFileIdentity(profileId) {
    const file = this._file(profileId);
    const main = validatePrivateFileStat(fs.lstatSync(file), file);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const target = file + suffix;
      try { validatePrivateFileStat(fs.lstatSync(target), target); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // Size and timestamps change after our own small append transactions.
    // dev+ino detects an external atomic replacement of the open DB file.
    return `${main.dev}:${main.ino}`;
  }

  _openExisting(profileId) {
    const file = this._file(profileId);
    if (!fs.existsSync(file)) return null;
    const db = openDatabase(file);
    try {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
        || this._meta(db, "schema_version") !== String(SCHEMA_VERSION)) {
        throw new Error("conversation index integrity/schema mismatch");
      }
      // PRAGMA integrity_check does not compare an external-content FTS5
      // posting list with its content table. A missing posting is otherwise a
      // silent false negative even though the ordinary SQLite tables are sound.
      db.prepare("INSERT INTO events_fts(events_fts,rank) VALUES('integrity-check',1)").run();
      this.dataVersions.set(profileId, this._dataVersion(db));
      this.fileIdentities.set(profileId, this._privateFileIdentity(profileId));
      return db;
    } catch (error) { db.close(); throw error; }
  }

  _insertSession(db, session) {
    db.prepare("INSERT INTO sessions(session_id,session_key,revision,last_seq,source_identity,workspace,status) VALUES(?,?,?,?,?,?,?)")
      .run(session.id, session.sessionKey, session.revision, session.lastSeq,
        session.sourceIdentity ?? null, session.workspace, session.status);
  }

  _insertRows(db, sessionId, rows) {
    const insert = db.prepare(`INSERT INTO events
      (session_id,event_id,seq,run_id,kind,occurred_at,content_hash,search_text,search_terms)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) {
      insert.run(sessionId, row.eventId, row.seq, row.runId, row.kind,
        row.occurredAt, row.contentHash, row.text, lexicalTerms(row.text).join(" "));
    }
  }

  whenReady(profileId) {
    return this.builds.get(profileId)?.promise || Promise.resolve();
  }

  _startBuild(profileId, sessions, policyRevision, loadPage, validateBuild) {
    if (this.builds.has(profileId)) return "rebuilding";
    const file = this._file(profileId);
    const temp = `${file}.building-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const job = { cancelled: false, promise: null, temp };
    this.builds.set(profileId, job);
    job.promise = (async () => {
      let db;
      try {
        // Let the tool return a rebuilding status before any large index work.
        await nextTick();
        if (job.cancelled) return;
        db = openDatabase(temp);
        db.exec(SCHEMA);
        transaction(db, () => {
          this._putMeta(db, "schema_version", SCHEMA_VERSION);
          this._putMeta(db, "policy_revision", policyRevision);
        });
        for (const session of sessions) {
          if (job.cancelled) return;
          transaction(db, () => this._insertSession(db, session));
          let afterSeq = 0;
          while (afterSeq < session.lastSeq) {
            if (job.cancelled) return;
            const page = loadPage(session, afterSeq, 256);
            if (!Number.isSafeInteger(page.throughSeq) || page.throughSeq <= afterSeq
              || page.throughSeq > session.lastSeq || !Array.isArray(page.rows)) {
              throw new Error("conversation index page cursor invalid");
            }
            transaction(db, () => this._insertRows(db, session.id, page.rows));
            afterSeq = page.throughSeq;
            await nextTick();
          }
        }
        if (job.cancelled || !validateBuild()) return;
        if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
          throw new Error("new conversation index integrity check failed");
        }
        db.prepare("INSERT INTO events_fts(events_fts,rank) VALUES('integrity-check',1)").run();
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close(); db = null;
        if (job.cancelled || !validateBuild()) return;
        const previous = this.connections.get(profileId);
        if (previous) { previous.close(); this.connections.delete(profileId); }
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          try {
            validatePrivateFileStat(fs.lstatSync(file + suffix), file + suffix);
            fs.unlinkSync(file + suffix);
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        fs.renameSync(temp, file);
        const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        this.connections.set(profileId, this._openExisting(profileId));
      } catch (error) {
        const unavailable = indexError(error);
        if (this.builds.get(profileId) === job && !job.cancelled) {
          this.failures.set(profileId, { error: unavailable, retryAfter: Date.now() + 5_000 });
        }
        throw unavailable;
      }
      finally {
        if (db) { try { db.close(); } catch { /* first failure is authoritative */ } }
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          try { fs.unlinkSync(temp + suffix); } catch (error) { if (error.code !== "ENOENT") break; }
        }
        if (this.builds.get(profileId) === job) this.builds.delete(profileId);
      }
    })();
    job.promise.catch(() => {});
    return "rebuilding";
  }

  ensure(profileId, sessions, policyRevision, loadPage, validateBuild, prefixDigest = null) {
    const validRevision = (Number.isSafeInteger(policyRevision) && policyRevision >= 0)
      || (typeof policyRevision === "string" && /^\d+:[a-f0-9]{64}$/u.test(policyRevision));
    if (!validRevision || !Array.isArray(sessions)
      || sessions.some((session) => session.sourceIdentity != null
        && (typeof session.sourceIdentity !== "string"
          || !/^[a-f0-9]{64}$/u.test(session.sourceIdentity)))) {
      throw serviceError("CONVERSATION_INDEX_INVALID", "会话索引输入无效");
    }
    if (this.builds.has(profileId)) return "rebuilding";
    if (!this.cleanedProfiles.has(profileId)) this._clearOrphanBuilds(profileId);
    const failure = this.failures.get(profileId);
    if (failure) {
      if (Date.now() < failure.retryAfter) throw failure.error;
      this.failures.delete(profileId);
    }
    try {
      let db = this.connections.get(profileId);
      if (!db) {
        try { db = this._openExisting(profileId); }
        catch { db = null; }
        if (db) this.connections.set(profileId, db);
      }
      if (db && (this.fileIdentities.get(profileId) !== this._privateFileIdentity(profileId)
        || this.dataVersions.get(profileId) !== this._dataVersion(db))) {
        // A second SQLite connection changed the derived index, or an atomic
        // replacement moved the path away from this open handle. Rebuild.
        this.forgetProfile(profileId);
        return this._startBuild(profileId, sessions, policyRevision, loadPage, validateBuild);
      }
      if (!db || this._meta(db, "policy_revision") !== String(policyRevision)) {
        return this._startBuild(profileId, sessions, policyRevision, loadPage, validateBuild);
      }
      const known = new Map(db.prepare("SELECT session_id,session_key,revision,last_seq,source_identity,workspace,status FROM sessions")
        .all().map((row) => [row.session_id, row]));
      const current = new Set(sessions.map((session) => session.id));
      const removed = [...known.keys()].filter((id) => !current.has(id));
      const changed = sessions.filter((session) => {
        const row = known.get(session.id);
        return !row || row.session_key !== session.sessionKey || row.workspace !== session.workspace
          || row.status !== session.status || row.revision !== session.revision
          || row.last_seq !== session.lastSeq
          || row.source_identity !== (session.sourceIdentity ?? null);
      });
      if (!removed.length && !changed.length) return "ready";
      const totalNewEvents = changed.reduce((sum, session) => (
        sum + session.lastSeq - (known.get(session.id)?.last_seq || 0)
      ), 0);
      const smallAppend = totalNewEvents <= 64 && changed.every((session) => {
        const old = known.get(session.id);
        if (!old) return session.lastSeq <= 64;
        const delta = session.lastSeq - old.last_seq;
        return Number.isSafeInteger(old.revision) && old.revision >= 0
          && Number.isSafeInteger(old.last_seq) && old.last_seq >= 0
          && old.session_key === session.sessionKey && old.workspace === session.workspace
          && old.status === session.status && delta > 0 && delta <= 64
          && session.revision - old.revision === delta
          && (old.source_identity === null && session.sourceIdentity == null
            || (old.source_identity !== null && typeof prefixDigest === "function"
              && prefixDigest(session, old.revision) === old.source_identity));
      });
      if (!removed.length && smallAppend) {
        const pages = changed.map((session) => ({ session,
          previous: known.get(session.id), page: loadPage(session,
            known.get(session.id)?.last_seq || 0, 64) }));
        if (pages.some(({ session, page }) => page.throughSeq !== session.lastSeq)) {
          return this._startBuild(profileId, sessions, policyRevision, loadPage, validateBuild);
        }
        transaction(db, () => {
          for (const session of changed) {
            const entry = pages.find((page) => page.session.id === session.id);
            if (!entry.previous) this._insertSession(db, session);
            this._insertRows(db, session.id, entry.page.rows);
            if (entry.previous) db.prepare("UPDATE sessions SET revision=?,last_seq=?,source_identity=? WHERE session_id=?")
              .run(session.revision, session.lastSeq, session.sourceIdentity ?? null, session.id);
          }
        });
        return "ready";
      }
      return this._startBuild(profileId, sessions, policyRevision, loadPage, validateBuild);
    } catch (error) {
      if (error.code === "CONVERSATION_INDEX_UNAVAILABLE") throw error;
      this.forgetProfile(profileId);
      throw indexError(error);
    }
  }

  search(profileId, query, limit, workspace, sessionId = null) {
    const db = this.connections.get(profileId);
    if (!db) throw indexError(new Error("index closed"));
    try {
      const terms = lexicalTerms(query);
      if (terms.length === 0 || ([...query].length === 1 && /\p{Script=Han}/u.test(query))) {
        return db.prepare(`SELECT e.session_id,e.event_id,e.seq,e.run_id,e.kind,e.occurred_at,e.content_hash,
          0 AS rank FROM events e JOIN sessions s ON s.session_id=e.session_id
          WHERE s.workspace IS ? AND (? IS NULL OR e.session_id=?)
            AND instr(lower(e.search_text), lower(?)) > 0
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`).all(workspace, sessionId, sessionId, query, limit);
      }
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
      return db.prepare(`SELECT e.session_id,e.event_id,e.seq,e.run_id,e.kind,e.occurred_at,
        e.content_hash,bm25(events_fts) AS rank FROM events_fts
        JOIN events e ON e.id=events_fts.rowid
        JOIN sessions s ON s.session_id=e.session_id
        WHERE events_fts MATCH ? AND s.workspace IS ? AND (? IS NULL OR e.session_id=?)
        ORDER BY rank, e.occurred_at DESC LIMIT ?`).all(match, workspace, sessionId, sessionId, limit);
    } catch (error) {
      // A failed MATCH can be a damaged virtual table. Close this handle so
      // the next ensure validates the persisted file and rebuilds it if needed.
      try { this.forgetProfile(profileId); } catch { /* report the first failure */ }
      throw indexError(error);
    }
  }
}

module.exports = { ConversationRecallIndex, hashText, lexicalTerms };
