"use strict";

const fs = require("node:fs");
const { validatePrivateFileStat } = require("./security");
const { sqliteNativeBinding } = require("./sqlite-native-binding");

// Use the Node runtime SQLite engine when available. Older runtimes fall back
// to the pinned better-sqlite3 Node-API addon supplied for each architecture.
function openDatabase(filePath, { readOnly = false } = {}) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { validatePrivateFileStat(fs.lstatSync(filePath + suffix), filePath + suffix); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!fs.existsSync(filePath) && !readOnly) {
    const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
  }
  let Database;
  let builtin = true;
  try { Database = require("node:sqlite").DatabaseSync; }
  catch (error) {
    if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    Database = require("better-sqlite3"); builtin = false;
  }
  const nativeBinding = !builtin ? sqliteNativeBinding() : null;
  const db = new Database(filePath, { ...(process.versions.electron && nativeBinding && !builtin ? { nativeBinding } : {}),
    ...(readOnly ? { [builtin ? "readOnly" : "readonly"]: true } : {}) });
  if (readOnly) return db;
  try { db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL;"); }
  catch (error) { db.close(); throw error; }
  return db;
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE ideas (
  id TEXT PRIMARY KEY, sort_at INTEGER NOT NULL, archived INTEGER NOT NULL,
  favorite INTEGER NOT NULL, deleted INTEGER NOT NULL, bucket TEXT NOT NULL,
  latest_id TEXT, search TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  CHECK(id=json_extract(data,'$.id') AND sort_at=-json_extract(data,'$.updatedAt')
    AND favorite=json_extract(data,'$.favorite') AND archived=(json_extract(data,'$.archivedAt') IS NOT NULL)
    AND deleted=(json_extract(data,'$.deletedAt') IS NOT NULL))
);
CREATE INDEX ideas_page ON ideas(deleted, archived, sort_at, id);
CREATE INDEX ideas_bucket_page ON ideas(deleted, archived, bucket, sort_at, id);
CREATE INDEX ideas_favorite_page ON ideas(deleted, archived, favorite, sort_at, id);
CREATE TABLE executions (
  id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES ideas(id), run_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL UNIQUE, session_key TEXT, backend_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, created_at INTEGER NOT NULL, external INTEGER NOT NULL,
  status TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  CHECK(id=json_extract(data,'$.id') AND idea_id=json_extract(data,'$.ideaId') AND run_id=json_extract(data,'$.runId')
    AND operation_id=json_extract(data,'$.operationId') AND session_key IS json_extract(data,'$.sessionKey')
    AND backend_id=json_extract(data,'$.backendId') AND agent_id=json_extract(data,'$.agentId')
    AND created_at=json_extract(data,'$.createdAt') AND external=(json_extract(data,'$.external') IS NOT NULL))
);
CREATE INDEX executions_idea ON executions(idea_id, created_at DESC, id DESC);
CREATE INDEX executions_session ON executions(session_key, backend_id, agent_id, created_at DESC, id DESC);
CREATE INDEX executions_pending ON executions(external, status, created_at DESC, id DESC);
CREATE TABLE operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, type TEXT NOT NULL, target_id TEXT NOT NULL);
CREATE VIRTUAL TABLE ideas_search USING fts5(search, content='ideas', content_rowid='rowid', tokenize='trigram case_sensitive 1');
CREATE TRIGGER ideas_search_insert AFTER INSERT ON ideas BEGIN
  INSERT INTO ideas_search(rowid,search) VALUES (new.rowid,new.search);
END;
CREATE TRIGGER ideas_search_update AFTER UPDATE OF search ON ideas WHEN old.search != new.search BEGIN
  INSERT INTO ideas_search(ideas_search,rowid,search) VALUES ('delete',old.rowid,old.search);
  INSERT INTO ideas_search(rowid,search) VALUES (new.rowid,new.search);
END;
CREATE TRIGGER ideas_search_delete AFTER DELETE ON ideas BEGIN
  INSERT INTO ideas_search(ideas_search,rowid,search) VALUES ('delete',old.rowid,old.search);
END;
`;

function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back a full disk error. */ }
    throw error;
  }
}

module.exports = { openDatabase, SCHEMA, transaction };

// All tables are created together for a fresh current-schema database.
module.exports.GROWTH_SCHEMA = `
CREATE INDEX ideas_growth_queue ON ideas(deleted, archived, bucket);
CREATE TABLE growth_jobs (
  idea_id TEXT PRIMARY KEY REFERENCES ideas(id), state TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  CHECK(idea_id=json_extract(data,'$.ideaId') AND state=json_extract(data,'$.state'))
);
CREATE INDEX growth_jobs_state ON growth_jobs(state, idea_id);
`;
