"use strict";

// 2026-10-20: Codex desktop discovery ran a full scan of the client database for
// every page, every few seconds, on the Service loop (0.6–1.3s when cold).
// Pages now come from one snapshot reused until the database or WAL changes.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { CodexDesktopSessionStore } = require("../app/agent-service/codex-desktop-session-store");

function fixture(t, { rows = 250 } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-discovery-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const writer = new DatabaseSync(path.join(home, "state_5.sqlite"));
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,created_at INTEGER,updated_at INTEGER,updated_at_ms INTEGER,
    source TEXT,originator TEXT,thread_source TEXT,archived INTEGER,title TEXT,cwd TEXT,model TEXT,reasoning_effort TEXT,name TEXT)`);
  const insert = writer.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const add = (updated, options = {}) => {
    const id = options.id || crypto.randomUUID();
    insert.run(id, path.join(home, "sessions", `${id}.jsonl`), 1, Math.floor(updated / 1000), updated,
      options.source || "vscode", options.originator || "Codex Desktop", options.threadSource ?? null,
      options.archived || 0, `thread ${updated}`, home, null, null, null);
    return id;
  };
  // Equal timestamps exercise the id tie-break of the cursor.
  for (let i = 0; i < rows; i += 1) add(1_000_000 + Math.floor(i / 3) * 1000);
  add(5_000_000, { archived: 1 }); add(5_000_000, { originator: "codex-tui", source: "cli" });
  add(5_000_000, { threadSource: "shoggoth:fixture" });
  let opens = 0;
  const store = new CodexDesktopSessionStore({ home, databaseFactory: file => {
    opens += 1; return new DatabaseSync(file, { readOnly: true });
  } });
  return { store, add, opens: () => opens };
}

function pageAll(read) {
  const all = [];
  let after = null;
  for (;;) {
    const rows = read(after);
    all.push(...rows.slice(0, 100));
    if (rows.length <= 100) return all;
    const last = rows[99];
    after = { updatedAt: last.updatedAt, id: last.id };
  }
}

test("discovery pages come from one snapshot and match the direct SQL paging", (t) => {
  const f = fixture(t);
  const cached = pageAll(after => f.store.readRows({ after, limit: 101 }));
  assert.equal(f.opens(), 1, "paging an unchanged database opens it once");
  const direct = pageAll(after => f.store.selectRows({ after, limit: 101 }));
  assert.deepEqual(cached.map(row => row.id), direct.map(row => row.id));
  assert.equal(cached.length, 250, "archived, CLI and Shoggoth-owned threads stay excluded");
  pageAll(after => f.store.readRows({ after, limit: 101 }));
  assert.equal(f.opens(), 1 + 3, "a second unchanged discovery round is served from the snapshot");
});

test("a write to the client database (WAL) invalidates the snapshot", (t) => {
  const f = fixture(t, { rows: 5 });
  assert.equal(f.store.readRows({ limit: 101 }).length, 5);
  const opens = f.opens();
  const id = f.add(9_000_000);
  const rows = f.store.readRows({ limit: 101 });
  assert.equal(f.opens(), opens + 1, "a changed WAL rebuilds the snapshot");
  assert.equal(rows.length, 6);
  assert.equal(rows[0].id, id, "the newest thread is listed first");
  rows[0].title = "mutated by caller";
  assert.notEqual(f.store.readRows({ limit: 101 })[0].title, "mutated by caller", "callers get copies");
});

test("single-thread reads still query the database directly", (t) => {
  const f = fixture(t, { rows: 3 });
  const [first] = f.store.readRows({ limit: 1 });
  const opens = f.opens();
  assert.equal(f.store.readRows({ threadId: first.id, limit: 1 })[0].id, first.id);
  assert.equal(f.opens(), opens + 1);
});
