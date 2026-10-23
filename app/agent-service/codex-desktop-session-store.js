"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { serviceError } = require("./security");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ORIGINATORS = ["Codex Desktop", "codex_work_desktop", "codex_desktop"];
const fail = code => { throw serviceError(code, code); };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function desktopSessionKey(homeIdentity, profileId, threadId) {
  const hex = digest(JSON.stringify(["codex-desktop", homeIdentity, profileId, threadId]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function isDesktopBinding(binding) { return /^bind-desktop-[a-f0-9]{32}$/u.test(binding?.operationId || ""); }

// The client database remains authoritative. No conversation or client sidebar
// state is copied or written by discovery; attach is a separate user action.
class CodexDesktopSessionStore {
  constructor({ home, databaseFactory }) {
    this.home = fs.realpathSync(home);
    this.homeIdentity = digest(this.home).slice(0, 24);
    this.databaseFactory = databaseFactory || (file => new (require("node:sqlite").DatabaseSync)(file, { readOnly: true }));
  }
  stateFile() {
    const files = fs.readdirSync(this.home).filter(name => /^state_\d+\.sqlite$/u.test(name))
      .sort((a, b) => Number(b.match(/\d+/u)[0]) - Number(a.match(/\d+/u)[0]));
    if (!files.length) fail("CODEX_DESKTOP_STORAGE_UNAVAILABLE");
    const file = path.join(this.home, files[0]);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file) fail("CODEX_DESKTOP_STORAGE_UNAVAILABLE");
    return file;
  }
  query(callback, file = this.stateFile()) {
    let db;
    try {
      db = this.databaseFactory(file);
      db.exec("PRAGMA query_only=ON");
      const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map(row => row.name));
      if (!["id", "originator", "source", "thread_source", "archived", "title", "cwd", "created_at", "updated_at", "rollout_path"].every(key => columns.has(key))) fail("CODEX_DESKTOP_FORMAT_UNSUPPORTED");
      return callback(db, columns);
    } catch (error) {
      if (String(error?.code).startsWith("CODEX_DESKTOP_")) throw error;
      fail("CODEX_DESKTOP_STORAGE_UNAVAILABLE");
    } finally { db?.close(); }
  }
  // Discovery pages are read every few seconds while the App lists sessions. A
  // full scan of the client database blocks the Service loop for up to a second
  // when its pages are not cached, so all pages come from one snapshot reused
  // while the database and its WAL file are unchanged.
  readRows({ threadId = null, after = null, limit = 100 } = {}) {
    if (threadId) return this.selectRows({ threadId, after, limit });
    let file;
    try { file = this.stateFile(); } catch (error) {
      if (String(error?.code).startsWith("CODEX_DESKTOP_")) throw error;
      fail("CODEX_DESKTOP_STORAGE_UNAVAILABLE");
    }
    const stamp = this.fileStamp(file);
    if (this.snapshot?.stamp !== stamp) this.snapshot = { stamp, rows: this.selectRows({ limit: -1 }, file) };
    const rows = this.snapshot.rows;
    const start = after ? rows.findIndex(row => row.updatedAt < after.updatedAt
      || (row.updatedAt === after.updatedAt && row.id < after.id)) : 0;
    return start < 0 ? [] : structuredClone(rows.slice(start, start + limit));
  }
  fileStamp(file) {
    const stat = target => {
      try {
        const value = fs.lstatSync(target, { bigint: true });
        return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
      } catch (error) { if (error.code === "ENOENT") return "-"; throw error; }
    };
    return `${file}|${stat(file)}|${stat(`${file}-wal`)}`;
  }
  selectRows({ threadId = null, after = null, limit = 100 } = {}, file) {
    return this.query((db, columns) => {
      const created = columns.has("created_at_ms") ? "COALESCE(created_at_ms,created_at*1000)" : "created_at*1000";
      const updated = columns.has("updated_at_ms") ? "COALESCE(updated_at_ms,updated_at*1000)" : "updated_at*1000";
      const optional = name => columns.has(name) ? name : `NULL AS ${name}`;
      const values = [...ORIGINATORS];
      let where = `originator IN (${ORIGINATORS.map(() => "?").join(",")}) AND source IN ('vscode','appServer')
        AND archived=0 AND (thread_source IS NULL OR thread_source NOT LIKE 'shoggoth:%')`;
      if (threadId) { where += " AND id=?"; values.push(threadId); }
      if (after) { where += ` AND (${updated}<? OR (${updated}=? AND id<?))`; values.push(after.updatedAt, after.updatedAt, after.id); }
      values.push(limit);
      return db.prepare(`SELECT id,title,cwd,rollout_path,thread_source,${created} AS createdAt,${updated} AS updatedAt,
        ${optional("model")},${optional("reasoning_effort")},${optional("name")} FROM threads
        WHERE ${where} ORDER BY ${updated} DESC,id DESC LIMIT ?`).all(...values).map(row => {
        if (!UUID.test(row.id) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0
          || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < row.createdAt
          || typeof row.cwd !== "string" || !path.isAbsolute(row.cwd) || row.cwd.includes("\0")
          || Buffer.byteLength(row.cwd) > 4096) fail("CODEX_DESKTOP_FORMAT_UNSUPPORTED");
        return row;
      });
    }, file);
  }
  get(threadId) {
    if (!UUID.test(threadId)) fail("CODEX_DESKTOP_NOT_FOUND");
    const row = this.readRows({ threadId, limit: 1 })[0];
    if (!row) fail("CODEX_DESKTOP_NOT_FOUND");
    // A database entry alone must not grant access to an unrelated rollout.
    const file = row.rollout_path, root = path.join(this.home, "sessions");
    if (typeof file !== "string" || !path.resolve(file).startsWith(root + path.sep)
      || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) fail("CODEX_DESKTOP_NOT_FOUND");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0), end = buffer.indexOf(10, 0);
      if (end < 0 || end >= read) fail("CODEX_DESKTOP_FORMAT_UNSUPPORTED");
      const meta = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      if (meta.type !== "session_meta" || meta.payload?.id !== threadId
        || !ORIGINATORS.includes(meta.payload.originator) || meta.payload.thread_source?.startsWith("shoggoth:")) fail("CODEX_DESKTOP_NOT_FOUND");
    } finally { fs.closeSync(fd); }
    return row;
  }
}

module.exports = { CodexDesktopSessionStore, desktopSessionKey, isDesktopBinding, UUID, digest };
