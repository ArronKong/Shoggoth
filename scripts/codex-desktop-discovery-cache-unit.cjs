"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { CodexDesktopSessionStore } = require("../app/agent-service/codex-desktop-session-store");
const { CodexDesktopDiscovery } = require("../app/agent-service/codex-desktop-discovery-worker");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

function fixture(t, { rows = 250, wal = true, pathExists = true } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-discovery-")));
  const discovery = new CodexDesktopDiscovery();
  let writer;
  t.after(async () => {
    await discovery.close();
    writer?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  if (!pathExists) return { home, discovery };
  const file = path.join(home, "state_5.sqlite");
  writer = new DatabaseSync(file);
  if (wal) writer.exec("PRAGMA journal_mode=WAL");
  writer.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,created_at INTEGER,updated_at INTEGER,updated_at_ms INTEGER,
    source TEXT,originator TEXT,thread_source TEXT,archived INTEGER,title TEXT,cwd TEXT,model TEXT,reasoning_effort TEXT,name TEXT);
    CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC,id DESC);
    CREATE INDEX idx_threads_updated_at_ms ON threads(updated_at_ms DESC,id DESC)`);
  const insert = writer.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const add = (updated, options = {}) => {
    const id = options.id || crypto.randomUUID();
    insert.run(id, path.join(home, "sessions", `${id}.jsonl`), 1, Math.floor(updated / 1000), options.legacy ? null : updated,
      options.source || "vscode", options.originator || "Codex Desktop", options.threadSource ?? null,
      options.archived || 0, `thread ${updated}`, home, null, null, null);
    return id;
  };
  const expected = [];
  writer.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    // Include cross-lane ties and seconds fallbacks on the cursor boundary.
    const legacy = i % 7 === 0;
    const updatedAt = 1_000_000 + Math.floor(i / 3) * 1000 + (i % 5 === 0 && !legacy ? 20 : 0);
    expected.push({ id: add(updatedAt, { legacy }), updatedAt });
  }
  add(9_000_000, { archived: 1 });
  add(9_000_000, { originator: "codex-tui", source: "cli" });
  add(9_000_000, { threadSource: "shoggoth:fixture" });
  writer.exec("COMMIT");
  expected.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  return { home, file, writer, discovery, expected, add, store: new CodexDesktopSessionStore({ home }) };
}

function next({ rows, snapshotId }, limit) {
  const { id, updatedAt } = rows[limit - 1];
  return { id, updatedAt, snapshotId };
}

for (const rowCount of [100, 1000, 10000]) test(`worker discovery pages ${rowCount} records in exact timestamp/ID order`, async t => {
  const { discovery, home, expected } = fixture(t, { rows: rowCount });
  let after = null;
  const result = [];
  for (;;) {
    const page = await discovery.read({ home, after, limit: 101 });
    result.push(...page.rows.slice(0, 100).map(({ id, updatedAt }) => ({ id, updatedAt })));
    if (page.rows.length <= 100) break;
    after = next(page, 100);
  }
  assert.deepEqual(result, expected);
});

test("WAL updates refresh the first page, and cursor reads retain their snapshot across moves and deletes", async t => {
  const { discovery, home, writer, expected, add, store } = fixture(t);
  const limit = 9;
  const first = await discovery.read({ home, after: null, limit });
  const during = writer.prepare("UPDATE threads SET updated_at_ms=? WHERE id=?");
  during.run(2_000_000, expected[30].id);
  during.run(999_000, expected[0].id);
  writer.prepare("DELETE FROM threads WHERE id=?").run(expected[20].id);
  const newest = add(3_000_000);
  const second = await discovery.read({ home, after: next(first, limit - 1), limit });
  const third = await discovery.read({ home, after: next(second, limit - 1), limit });
  assert.deepEqual(second.rows.map(x => x.id), expected.slice(8, 17).map(x => x.id));
  assert.deepEqual(third.rows.map(x => x.id), expected.slice(16, 25).map(x => x.id));
  for (let i = 0; i < 10; i++) {
    during.run(3_000_000 + i, newest);
    const fresh = await discovery.read({ home, after: null, limit });
    assert.equal(fresh.rows.length, limit);
    assert.equal(fresh.rows[0].id, newest);
    assert.equal(fresh.rows[0].updatedAt, 3_000_000 + i);
  }
  assert.equal(store.readRows({ threadId: expected[20].id, limit: 1 }).length, 0);
});

test("SQL uses native ordering and strictly bounded pages even when the WAL changes", t => {
  const { home, writer, add } = fixture(t, { rows: 10000 });
  const statements = [];
  const store = new CodexDesktopSessionStore({ home, databaseFactory: file => {
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      exec: sql => db.exec(sql),
      close: () => db.close(),
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("SELECT id,")) return statement;
        return { all(...params) {
          const executionPlan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
          assert.ok(executionPlan.every(row => !row.detail.includes("TEMP B-TREE")), sql);
          statements.push({ sql, limit: params.at(-1) });
          return statement.all(...params);
        } };
      },
    };
  } });
  const id = add(9_000_000);
  const update = writer.prepare("UPDATE threads SET updated_at_ms=? WHERE id=?");
  for (let i = 0; i < 10; i++) {
    update.run(9_000_000 + i, id);
    const first = store.readRows({ limit: 8 });
    assert.equal(first[0].updatedAt, 9_000_000 + i);
    assert.equal(first.length, 8);
  }
  assert.equal(statements.length, 20);
  assert.ok(statements.every(statement => statement.limit === 8 && statement.sql.includes(" INDEXED BY idx_threads_updated_at")));
  assert.throws(() => store.readRows({ limit: -1 }), { code: "CODEX_DESKTOP_PARAMS_INVALID" });
});

test("a missing, locked, or unsupported source does not poison the worker; a lost view requires a fresh first page", async t => {
  const f = fixture(t, { rows: 12, wal: false });
  const missing = fixture(t, { pathExists: false });
  const read = (after = null) => f.discovery.read({ home: f.home, after, limit: 5 });
  await assert.rejects(read({ ...f.expected[0], snapshotId: crypto.randomUUID() }), { code: "CODEX_DESKTOP_UNAVAILABLE" });
  await assert.rejects(f.discovery.read({ home: missing.home, after: null, limit: 5 }), { code: "CODEX_DESKTOP_STORAGE_UNAVAILABLE" });

  f.writer.exec("BEGIN EXCLUSIVE");
  let serviced = false;
  const timer = setTimeout(() => { serviced = true; }, 20);
  try {
    await assert.rejects(read(), { code: "CODEX_DESKTOP_STORAGE_UNAVAILABLE" });
    assert.equal(serviced, true, "the main event loop remains responsive during the SQLite lock wait");
  } finally { clearTimeout(timer); f.writer.exec("ROLLBACK"); }

  const page = await read();
  await f.discovery.close();
  f.discovery.open();
  await assert.rejects(read(next(page, 4)), { code: "CODEX_DESKTOP_UNAVAILABLE" });
  const fresh = await read();
  assert.equal(fresh.rows.length, 5);
  await f.discovery.close();
  f.discovery.open();
  f.writer.exec("ALTER TABLE threads RENAME COLUMN originator TO unknown_originator");
  await assert.rejects(read(), { code: "CODEX_DESKTOP_FORMAT_UNSUPPORTED" });
});

test("query and close racing against worker startup settle without leaking a request", async t => {
  const { discovery, home } = fixture(t);
  const pending = discovery.read({ home, after: null, limit: 5 });
  const rejected = assert.rejects(pending, { code: "CODEX_DESKTOP_STORAGE_UNAVAILABLE" });
  await discovery.close();
  await rejected;
  assert.equal(discovery.pending.size, 0);
  discovery.open();
  assert.equal((await discovery.read({ home, after: null, limit: 5 })).rows.length, 5);
});

test("periodic discovery reads just the first page and drops missing entries only after reconciliation", async () => {
  const backend = new ShoggothBackend();
  backend._state = "started";
  backend._codexAutomationOwnerId = "desktop-owner";
  backend._mergeCodexDesktopSessions = () => {};
  const make = sessionKey => ({ session: { profileId: "desktop-owner", sessionKey } });
  let latest = make("recent");
  let older = make("old");
  const reads = [];
  backend._call = async (_method, { cursor }) => {
    reads.push(cursor);
    if (cursor === null) return { available: true, sessions: [latest], hasMore: true, nextCursor: "older" };
    return { available: true, sessions: older ? [older] : [], hasMore: false, nextCursor: null };
  };
  await backend._refreshCodexDesktopSessions();
  assert.deepEqual(reads, [null, "older"]);
  older = null;
  latest = make("new");
  backend._codexDesktopRefreshedAt -= 6000;
  backend.getSessionRowsSnapshot();
  await backend._codexDesktopRefresh;
  assert.deepEqual(reads, [null, "older", null]);
  assert.deepEqual([...backend._codexDesktopEntries.keys()], ["recent", "old", "new"]);
  backend._codexDesktopReconcileAt = 0;
  backend._codexDesktopRefreshedAt -= 6000;
  backend.getSessionRowsSnapshot();
  await backend._codexDesktopRefresh;
  assert.deepEqual(reads, [null, "older", null, null, "older"]);
  assert.deepEqual([...backend._codexDesktopEntries.keys()], ["new"]);
});
