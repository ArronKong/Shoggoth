"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { serviceError } = require("./security");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ORIGINATORS = ["Codex Desktop", "codex_work_desktop", "codex_desktop"];
const MAX_DISCOVERY_ROWS = 101;
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
  openDatabase(file = this.stateFile()) {
    let db;
    try {
      db = this.databaseFactory(file);
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100");
      const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map(row => row.name));
      if (!["id", "originator", "source", "thread_source", "archived", "title", "cwd", "created_at", "updated_at", "rollout_path"].every(key => columns.has(key))) fail("CODEX_DESKTOP_FORMAT_UNSUPPORTED");
      const indexes = new Set(db.prepare("PRAGMA index_list(threads)").all()
        .filter(index => index.partial === 0).map(index => index.name));
      return { db, columns, indexes };
    } catch (error) {
      db?.close();
      if (String(error?.code).startsWith("CODEX_DESKTOP_")) throw error;
      fail("CODEX_DESKTOP_STORAGE_UNAVAILABLE");
    }
  }

  readRows({ threadId = null, after = null, limit = 100 } = {}) {
    let connection;
    try {
      connection = this.openDatabase();
      return this.selectRows(connection, { threadId, after, limit });
    } catch (error) {
      if (String(error?.code).startsWith("CODEX_DESKTOP_")) throw error;
      fail("CODEX_DESKTOP_STORAGE_UNAVAILABLE");
    } finally { connection?.db.close(); }
  }

  selectRows({ db, columns, indexes }, { threadId = null, after = null, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_ROWS) fail("CODEX_DESKTOP_PARAMS_INVALID");
    const created = columns.has("created_at_ms") ? "COALESCE(created_at_ms,created_at*1000)" : "created_at*1000";
    const hasMillis = columns.has("updated_at_ms");
    const optional = (name, size) => columns.has(name) ? `substr(${name},1,${size}) AS ${name}` : `NULL AS ${name}`;
    const select = (updated, timestamp, condition = "", cursorScale = 1) => {
      const values = [...ORIGINATORS];
      let where = `originator IN (${ORIGINATORS.map(() => "?").join(",")}) AND source IN ('vscode','appServer')
        AND archived=0 AND (thread_source IS NULL OR thread_source NOT LIKE 'shoggoth:%')${condition}`;
      if (threadId) { where += " AND id=?"; values.push(threadId); }
      if (after) {
        const time = Math.floor(after.updatedAt / cursorScale);
        if (time * cursorScale === after.updatedAt) {
          where += ` AND (${timestamp},id)<(?,?)`;
          values.push(time, after.id);
        } else {
          where += ` AND ${timestamp}<=?`;
          values.push(time);
        }
      }
      // Prefer shipped Codex indexes for this order; the optimizer can otherwise
      // choose the archived index and sort every row despite the page's LIMIT.
      const index = `idx_threads_${timestamp}`;
      const hint = !threadId && indexes.has(index) ? ` INDEXED BY ${index}` : "";
      return db.prepare(`SELECT id,substr(title,1,512) AS title,
        CASE WHEN length(CAST(cwd AS BLOB))<=4096 THEN cwd END AS cwd,
        ${threadId ? "rollout_path,thread_source," : ""}${created} AS createdAt,${updated} AS updatedAt,
        ${optional("model", 512)},${optional("reasoning_effort", 32)},${optional("name", 512)} FROM threads${hint}
        WHERE ${where}${threadId ? "" : ` ORDER BY ${timestamp} DESC,id DESC`} LIMIT ?`).all(...values, limit);
    };
    let rows;
    if (threadId) {
      const updated = hasMillis ? "COALESCE(updated_at_ms,updated_at*1000)" : "updated_at*1000";
      rows = select(updated, "updated_at");
    } else if (!hasMillis) {
      rows = select("updated_at*1000", "updated_at", "", 1000);
    } else {
      // Keep both native index orders usable while retaining the legacy
      // seconds fallback for databases still containing NULL milliseconds.
      rows = select("updated_at_ms", "updated_at_ms", " AND updated_at_ms IS NOT NULL");
      if (!indexes.has("idx_threads_updated_at_ms") || db.prepare(
        "SELECT 1 FROM threads INDEXED BY idx_threads_updated_at_ms WHERE updated_at_ms IS NULL LIMIT 1",
      ).get()) {
        rows.push(...select("updated_at*1000", "updated_at", " AND updated_at_ms IS NULL", 1000));
        rows.sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? 1 : -1));
        rows.length = Math.min(rows.length, limit);
      }
    }
    for (const row of rows) {
      if (typeof row.id !== "string" || !UUID.test(row.id) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0
        || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < row.createdAt
        || typeof row.cwd !== "string" || !path.isAbsolute(row.cwd) || row.cwd.includes("\0")) fail("CODEX_DESKTOP_FORMAT_UNSUPPORTED");
    }
    return rows;
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
