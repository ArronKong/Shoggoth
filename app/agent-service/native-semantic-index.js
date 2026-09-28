"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { openDatabase, transaction } = require("./inspiration-database");
const { ensurePrivateDirectoryTree, validatePrivateFileStat } = require("./security");
const { hashText, embeddingError } = require("./e5-encoder");
const { createLanguageScoreCenter } = require("./memory-semantic-ranking");

const DIMENSIONS = 384;
const DOMAINS = new Set(["memory", "conversation"]);
const SCHEMA = `
CREATE TABLE metadata (domain TEXT PRIMARY KEY, stamp TEXT, building TEXT,
  documents INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0);
CREATE TABLE documents (
  domain TEXT NOT NULL, id TEXT NOT NULL, content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(json_valid(source)), seen TEXT NOT NULL,
  PRIMARY KEY(domain,id)
);
CREATE TABLE vectors (
  domain TEXT NOT NULL, document_id TEXT NOT NULL, part INTEGER NOT NULL,
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, vector BLOB NOT NULL,
  vector_hash TEXT NOT NULL,
  PRIMARY KEY(domain,document_id,part),
  FOREIGN KEY(domain,document_id) REFERENCES documents(domain,id) ON DELETE CASCADE,
  CHECK(length(vector)=1536 AND start_at>=0 AND end_at>=start_at)
);
CREATE TABLE identity (value TEXT NOT NULL);
PRAGMA user_version=2;
`;

const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const shaBytes = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");

function validateSource(domain, source) {
  if (!DOMAINS.has(domain) || !source || !validId(source.sourceId)
    || !(source.workspace === null || typeof source.workspace === "string" && source.workspace.length <= 4096)
    || !["han", "other"].includes(source.language)
    || !Number.isSafeInteger(source.occurredAt) || source.occurredAt < 0) throw embeddingError("E5_SOURCE_INVALID");
  if (domain === "memory") {
    if (!["user", "agent", "project", "workspace"].includes(source.scope)
      || ![0, 1].includes(source.sensitivity)
      || !Number.isSafeInteger(source.validFrom) || source.validFrom < 0
      || !(source.validUntil === null || Number.isSafeInteger(source.validUntil))
      || !Array.isArray(source.workspaceRefs) || source.workspaceRefs.length > 128
      || source.workspaceRefs.some(ref => !/^workspace:[a-f0-9]{64}$/u.test(ref))) throw embeddingError("E5_SOURCE_INVALID");
  } else if (!validId(source.sessionId) || !validId(source.eventId) || !validId(source.runId)
    || !Number.isSafeInteger(source.seq) || source.seq < 1
    || !["user", "assistant"].includes(source.kind)) throw embeddingError("E5_SOURCE_INVALID");
}

function validateDocument(domain, document) {
  if (!validHash(document?.id) || !validHash(document?.contentHash)
    || typeof document.text !== "string" || !document.text.trim() || !document.text.isWellFormed()
    || Buffer.byteLength(document.text) > 1024 * 1024 || hashText(document.text) !== document.contentHash) {
    throw embeddingError("E5_SOURCE_INVALID");
  }
  validateSource(domain, document.source);
}

// This is a disposable, private vector cache in the inference child. Original
// text is never written here. Parent services re-read every selected source.
class NativeSemanticIndex {
  constructor({ paths, modelIdentity }) {
    if (!paths?.agentsDir || !paths?.trustedRoot || !validHash(modelIdentity)) throw embeddingError("E5_INDEX_PATH_INVALID");
    this.paths = paths;
    this.modelIdentity = modelIdentity;
    this.connections = new Map();
    this.fileIdentities = new Map();
    this.views = new Map();
    this.epochs = new Map();
  }

  _file(profileId, create = true) {
    if (!validId(profileId)) throw embeddingError("E5_INDEX_PROFILE_INVALID");
    const directory = path.join(this.paths.agentsDir, profileId);
    if (create) ensurePrivateDirectoryTree(directory, this.paths.trustedRoot);
    return path.join(directory, "native-memory-semantic.sqlite");
  }

  _open(profileId, recovered = false) {
    const file = this._file(profileId);
    if (this.connections.has(profileId)) {
      let stat;
      try { stat = validatePrivateFileStat(fs.lstatSync(file), file); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.invalidate(profileId); throw embeddingError("E5_INDEX_CORRUPT");
      }
      if (this.fileIdentities.get(profileId) !== `${stat.dev}:${stat.ino}`) {
        this.invalidate(profileId); throw embeddingError("E5_INDEX_CORRUPT");
      }
      return this.connections.get(profileId);
    }
    let db;
    try {
      db = openDatabase(file);
      const version = db.prepare("PRAGMA user_version").get().user_version;
      if (version === 0) {
        transaction(db, () => { db.exec(SCHEMA); db.prepare("INSERT INTO identity(value) VALUES(?)").run(this.modelIdentity); });
      } else if (version !== 2 || db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
        || db.prepare("SELECT value FROM identity").get()?.value !== this.modelIdentity) {
        db.close(); db = null;
        this.invalidate(profileId);
        if (recovered) throw embeddingError("E5_INDEX_CORRUPT");
        return this._open(profileId, true);
      }
      this.connections.set(profileId, db);
      const stat = validatePrivateFileStat(fs.lstatSync(file), file);
      this.fileIdentities.set(profileId, `${stat.dev}:${stat.ino}`);
      return db;
    } catch (error) {
      try { db?.close(); } catch {}
      this.connections.delete(profileId);
      if (!recovered && /(?:SQLITE_(?:CORRUPT|NOTADB)|database disk image is malformed|file is not a database|no such (?:table|column))/u.test(`${error.code} ${error.message}`)) {
        this.invalidate(profileId); return this._open(profileId, true);
      }
      throw error;
    }
  }

  _key(profileId, domain) {
    if (!validId(profileId) || !DOMAINS.has(domain)) throw embeddingError("E5_INDEX_DOMAIN_INVALID");
    return `${profileId}\0${domain}`;
  }

  begin(profileId, domain, stamp) {
    const key = this._key(profileId, domain);
    if (!validHash(stamp)) throw embeddingError("E5_INDEX_STAMP_INVALID");
    const db = this._open(profileId);
    this.views.delete(key);
    db.prepare("INSERT INTO metadata(domain,stamp,building) VALUES(?,NULL,?) ON CONFLICT(domain) DO UPDATE SET stamp=NULL,building=excluded.building,documents=0,chunks=0")
      .run(domain, stamp);
    return { epoch: this.epochs.get(profileId) ?? 0 };
  }

  current(profileId, domain, stamp, epoch) {
    return (this.epochs.get(profileId) ?? 0) === epoch
      && this.connections.get(profileId)?.prepare("SELECT building FROM metadata WHERE domain=?").get(domain)?.building === stamp;
  }

  cancel(profileId, domain) {
    this.views.delete(this._key(profileId, domain));
    this.connections.get(profileId)?.prepare("UPDATE metadata SET stamp=NULL,building=NULL WHERE domain=?").run(domain);
  }

  reusable(profileId, domain, document) {
    validateDocument(domain, document);
    const db = this._open(profileId);
    return db.prepare("SELECT content_hash FROM documents WHERE domain=? AND id=?").get(domain, document.id)?.content_hash === document.contentHash
      && db.prepare("SELECT count(*) AS count FROM vectors WHERE domain=? AND document_id=?").get(domain, document.id).count > 0;
  }

  write(profileId, domain, stamp, epoch, document, chunks = null) {
    validateDocument(domain, document);
    if (!this.current(profileId, domain, stamp, epoch)) throw embeddingError("E5_INDEX_CANCELLED");
    const db = this._open(profileId);
    transaction(db, () => {
      db.prepare(`INSERT INTO documents(domain,id,content_hash,source,seen) VALUES(?,?,?,?,?)
        ON CONFLICT(domain,id) DO UPDATE SET content_hash=excluded.content_hash,source=excluded.source,seen=excluded.seen`)
        .run(domain, document.id, document.contentHash, JSON.stringify(document.source), stamp);
      if (chunks === null) return;
      if (!Array.isArray(chunks) || !chunks.length) throw embeddingError("E5_VECTOR_INVALID");
      db.prepare("DELETE FROM vectors WHERE domain=? AND document_id=?").run(domain, document.id);
      const insert = db.prepare("INSERT INTO vectors(domain,document_id,part,start_at,end_at,vector,vector_hash) VALUES(?,?,?,?,?,?,?)");
      for (let part = 0; part < chunks.length; part++) {
        const chunk = chunks[part];
        if (!(chunk.vector instanceof Float32Array) || chunk.vector.length !== DIMENSIONS
          || chunk.vector.some(value => !Number.isFinite(value))
          || Math.abs(chunk.vector.reduce((sum, value) => sum + value * value, 0) - 1) > 0.001
          || !Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end)
          || chunk.start < 0 || chunk.end <= chunk.start || chunk.end > document.text.length) throw embeddingError("E5_VECTOR_INVALID");
        if (!document.text.slice(chunk.start, chunk.end).isWellFormed()) throw embeddingError("E5_VECTOR_INVALID");
        const bytes = Buffer.allocUnsafe(DIMENSIONS * 4);
        for (let dimension = 0; dimension < DIMENSIONS; dimension++) bytes.writeFloatLE(chunk.vector[dimension], dimension * 4);
        insert.run(domain, document.id, part, chunk.start, chunk.end, bytes, shaBytes(bytes));
      }
    });
  }

  commit(profileId, domain, stamp, epoch) {
    if (!this.current(profileId, domain, stamp, epoch)) throw embeddingError("E5_INDEX_CANCELLED");
    const db = this._open(profileId);
    let counts;
    transaction(db, () => {
      db.prepare("DELETE FROM documents WHERE domain=? AND seen<>?").run(domain, stamp);
      counts = { documents: db.prepare("SELECT count(*) AS count FROM documents WHERE domain=?").get(domain).count,
        chunks: db.prepare("SELECT count(*) AS count FROM vectors WHERE domain=?").get(domain).count };
      db.prepare("UPDATE metadata SET stamp=?,building=NULL,documents=?,chunks=? WHERE domain=?")
        .run(stamp, counts.documents, counts.chunks, domain);
    });
    return counts;
  }

  ready(profileId, domain, stamp) {
    return this._open(profileId).prepare("SELECT stamp FROM metadata WHERE domain=?").get(domain)?.stamp === stamp;
  }

  _rows(profileId, domain, stamp) {
    const key = this._key(profileId, domain);
    const db = this._open(profileId);
    const file = this._file(profileId);
    const stat = validatePrivateFileStat(fs.lstatSync(file), file);
    const fileIdentity = `${stat.dev}:${stat.ino}`;
    const version = db.prepare("PRAGMA data_version").get().data_version;
    const prior = this.views.get(key);
    if (prior?.stamp === stamp && prior.version === version && prior.fileIdentity === fileIdentity) return prior.rows;
    const metadata = db.prepare("SELECT stamp,documents,chunks FROM metadata WHERE domain=?").get(domain);
    const counts = { documents: db.prepare("SELECT count(*) AS count FROM documents WHERE domain=?").get(domain).count,
      chunks: db.prepare("SELECT count(*) AS count FROM vectors WHERE domain=?").get(domain).count };
    if (metadata?.stamp !== stamp || metadata.documents !== counts.documents || metadata.chunks !== counts.chunks) {
      throw embeddingError("E5_INDEX_CORRUPT");
    }
    // Stream SQLite rows so a cold matrix does not retain a second full copy
    // of every vector and source JSON while constructing the resident view.
    this.views.delete(key);
    while (this.views.size >= 2) this.views.delete(this.views.keys().next().value);
    const sourceRows = db.prepare(`SELECT d.id,d.content_hash,d.source,d.seen,v.part,v.start_at,v.end_at,v.vector,v.vector_hash
      FROM documents d JOIN vectors v ON d.domain=v.domain AND d.id=v.document_id
      WHERE d.domain=? ORDER BY d.id,v.part`).iterate(domain);
    let documentId, expectedPart = 0, documents = 0;
    const rows = [];
    for (const row of sourceRows) {
      if (row.id !== documentId) { documentId = row.id; expectedPart = 0; documents++; }
      if (row.part !== expectedPart++ || row.seen !== stamp) throw embeddingError("E5_INDEX_CORRUPT");
      const bytes = Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      if (bytes.length !== DIMENSIONS * 4 || shaBytes(bytes) !== row.vector_hash) throw embeddingError("E5_INDEX_CORRUPT");
      const vector = new Float32Array(DIMENSIONS);
      let norm = 0;
      for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
        vector[dimension] = bytes.readFloatLE(dimension * 4); norm += vector[dimension] ** 2;
      }
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.001) throw embeddingError("E5_INDEX_CORRUPT");
      let source;
      try { source = JSON.parse(row.source); validateSource(domain, source); }
      catch { throw embeddingError("E5_INDEX_CORRUPT"); }
      if (!validHash(row.id) || !validHash(row.content_hash)
        || !Number.isSafeInteger(row.start_at) || !Number.isSafeInteger(row.end_at)
        || row.start_at < 0 || row.end_at <= row.start_at) throw embeddingError("E5_INDEX_CORRUPT");
      rows.push({ id: row.id, contentHash: row.content_hash, source,
        part: row.part, start: row.start_at, end: row.end_at, vector });
    }
    if (rows.length !== counts.chunks || documents !== counts.documents) throw embeddingError("E5_INDEX_CORRUPT");
    this.views.set(key, { stamp, version, fileIdentity, rows });
    // Bound resident matrices to the most recently searched Profile/domain.
    while (this.views.size > 2) this.views.delete(this.views.keys().next().value);
    return rows;
  }

  search(profileId, domain, stamp, queryVector, filter = {}, limit = 60) {
    this._key(profileId, domain);
    if (!(queryVector instanceof Float32Array) || queryVector.length !== DIMENSIONS
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw embeddingError("E5_QUERY_INVALID");
    if (!this.ready(profileId, domain, stamp)) return { status: "rebuilding", results: [] };
    const now = filter.now ?? Date.now();
    const bestRows = [], bestScores = [], center = createLanguageScoreCenter();
    let best = null, bestScore = -Infinity;
    const finishDocument = () => {
      if (!best) return;
      const score = Math.max(-1, Math.min(1, bestScore));
      bestRows.push(best); bestScores.push(score); center.add(best.source.language, score);
      best = null; bestScore = -Infinity;
    };
    for (const row of this._rows(profileId, domain, stamp)) {
      // The matrix is ordered by document/part. Keep its best chunk without
      // allocating a result object for every document on every query.
      if (best && row.id !== best.id) finishDocument();
      const source = row.source;
      if (domain === "memory") {
        if (source.sensitivity > (filter.maxSensitivity ?? 0) || source.validFrom > now
          || (source.validUntil !== null && source.validUntil <= now)
          || (filter.scopes && !filter.scopes.includes(source.scope))
          || (["project", "workspace"].includes(source.scope) && filter.workspaceRef !== undefined
            && !source.workspaceRefs.includes(filter.workspaceRef))) continue;
      } else if (source.workspace !== filter.workspace || source.runId === filter.excludeRunId
        || (filter.sessionId && source.sessionId !== filter.sessionId)) continue;
      let score = 0;
      for (let dimension = 0; dimension < DIMENSIONS; dimension++) score += row.vector[dimension] * queryVector[dimension];
      if (!best || score > bestScore) { best = row; bestScore = score; }
    }
    finishDocument();
    const results = [];
    const compare = (left, right) => right.rankScore-left.rankScore || left.id.localeCompare(right.id);
    for (let i=0; i<bestRows.length; i++) {
      const row = bestRows[i], score = bestScores[i], rankScore = score-center.offset(row.source.language);
      if (results.length === limit) {
        const last = results.at(-1);
        if (rankScore < last.rankScore || (rankScore === last.rankScore && row.id.localeCompare(last.id) >= 0)) continue;
      }
      const candidate = { id: row.id, contentHash: row.contentHash, source: row.source,
        part: row.part, start: row.start, end: row.end, score, rankScore };
      let low=0, high=results.length;
      while (low<high) {
        const middle=(low+high)>>>1;
        if (compare(candidate,results[middle])<0) high=middle; else low=middle+1;
      }
      results.splice(low,0,candidate); if (results.length>limit) results.pop();
    }
    return { status: "ready", results };
  }

  invalidate(profileId) {
    this.epochs.set(profileId, (this.epochs.get(profileId) ?? 0) + 1);
    const db = this.connections.get(profileId);
    this.connections.delete(profileId);
    this.fileIdentities.delete(profileId);
    for (const key of this.views.keys()) if (key.startsWith(`${profileId}\0`)) this.views.delete(key);
    db?.close();
    const file = this._file(profileId, false);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { validatePrivateFileStat(fs.lstatSync(file + suffix), file + suffix); fs.unlinkSync(file + suffix); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  close() {
    for (const profileId of this.connections.keys()) this.epochs.set(profileId, (this.epochs.get(profileId) ?? 0) + 1);
    for (const db of this.connections.values()) db.close();
    this.connections.clear(); this.fileIdentities.clear(); this.views.clear();
  }
}

module.exports = { NativeSemanticIndex, validateDocument };
