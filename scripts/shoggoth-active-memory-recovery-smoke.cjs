"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { ActiveMemoryRuntime } = require("../app/agent-service/shoggoth-memory/active-memory-runtime.cjs");
const { NAMESPACE, RECOVERY_NAMESPACE, recoverActiveMemorySessions } = require("../app/agent-service/shoggoth-memory/active-memory-state.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-recovery-")); fs.chmodSync(root, 0o700);
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") }, databases = [];
  const workspace = path.join(root, "one"); fs.mkdirSync(workspace, { mode: 0o700 });
  const memory = path.join(workspace, "MEMORY.md"); fs.writeFileSync(memory, "Keep the real memory file unchanged.\n", { mode: 0o600 });
  const open = () => { const database = new MemoryDatabase({ paths, databasePath: path.join(paths.stateDir, "one.sqlite") }); database.open(); databases.push(database); return database; };
  const runtime = (database, overrides = {}) => {
    let calls = 0;
    const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
      roster: () => [{ id: "one", workspace }], sessions: {} });
    return new ActiveMemoryRuntime({ host, input: { profile: { id: "one" }, run: { id: crypto.randomUUID(), profileId: "one" } },
      config: core.normalizeActiveMemoryConfig({ mode: "always" }, {}, ["memory_search", "memory_get"]), runtimeConfig: {},
      signal: new AbortController().signal, check() {}, logger: { warn() {}, debug() {} },
      complete: async () => ++calls === 1 ? { text: '{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}' }
        : { text: '{"summary":"Isolated recovery fixture: amber telescope."}' },
      callTool: async () => ({ path: "MEMORY.md", text: "Isolated recovery fixture: amber telescope." }), ...overrides });
  };
  const retain = async database => {
    const instance = runtime(database);
    instance.store.delete = async () => { throw new Error("isolated cleanup failure"); };
    await assert.rejects(instance.run({ query: "Recall fixture telescope", searchQuery: "fixture telescope" }), /isolated cleanup failure/u);
    await instance.settled;
    return database.db.prepare("SELECT key,value FROM memory_state WHERE namespace=? AND key=?").get(NAMESPACE, instance.target.key);
  };
  const rows = database => database.db.prepare("SELECT key,value FROM memory_state WHERE namespace=?").all(NAMESPACE);
  t.after(() => { for (const database of databases) database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, workspace, memory, open, runtime, retain, rows };
}

test("new database lifetime reclaims owned native scratch including expired text, preserving facts and other namespaces", async t => {
  const f = fixture(t); let database = f.open();
  const retained = await f.retain(database);
  database.db.prepare("UPDATE memory_state SET expires_at=0 WHERE namespace=?").run(NAMESPACE);
  const other = database.openKeyedStore({ namespace: "unrelated", maxEntries: 10 });
  await other.register(retained.key, JSON.parse(retained.value));
  assert.throws(() => recoverActiveMemorySessions(database, "one"), { code: "MEMORY_ACTIVE_RECOVERY_PENDING" });
  database.close(); database = f.open();
  const result = recoverActiveMemorySessions(database, "one");
  assert.equal(result.recovered, 1); assert.equal(result.unresolved, 0); assert.deepEqual(f.rows(database), []);
  assert.equal(database.db.prepare("SELECT value FROM memory_state WHERE namespace='unrelated'").get().value, retained.value);
  assert.equal(fs.readFileSync(f.memory, "utf8"), "Keep the real memory file unchanged.\n");
  const receipt = JSON.parse(database.db.prepare("SELECT value FROM memory_state WHERE namespace=?").get(RECOVERY_NAMESPACE).value);
  assert.deepEqual(receipt, result); assert.ok(!JSON.stringify(receipt).includes("telescope"));
  await f.retain(database);
  assert.equal(recoverActiveMemorySessions(database, "one"), result, "startup recovery cannot sweep this lifetime's later records");
  assert.equal(f.rows(database).length, 1);
  assert.throws(() => recoverActiveMemorySessions(database, "two"), { code: "MEMORY_ACTIVE_RECOVERY_PENDING" });
});

test("unknown, oversized and cross-Profile scratch stays intact and disables only new Active Memory runtimes", async t => {
  const f = fixture(t); let database = f.open();
  const retained = await f.retain(database), record = JSON.parse(retained.value);
  record.entry.sessionFile = record.entry.sessionFile.replace("sqlite:one:", "sqlite:two:");
  const foreign = JSON.stringify(record);
  database.db.prepare("UPDATE memory_state SET value=? WHERE namespace=? AND key=?").run(foreign, NAMESPACE, retained.key);
  const store = database.openKeyedStore({ namespace: NAMESPACE, maxEntries: 64 });
  await store.register("oversized", "x".repeat(97 * 1024));
  await store.register("invalid", { unrelated: true });
  database.db.prepare("UPDATE memory_state SET value='invalid json' WHERE namespace=? AND key='invalid'").run(NAMESPACE);
  const before = f.rows(database); database.close(); database = f.open();
  const result = recoverActiveMemorySessions(database, "one");
  assert.equal(result.recovered, 0); assert.equal(result.unresolved, 3); assert.deepEqual(f.rows(database), before);
  assert.throws(() => f.runtime(database), { code: "MEMORY_ACTIVE_RECOVERY_PENDING" });
  assert.equal(fs.readFileSync(f.memory, "utf8"), "Keep the real memory file unchanged.\n");
});

test("recovery and its receipt roll back together when the durable receipt cannot commit", async t => {
  const f = fixture(t); let database = f.open();
  await f.retain(database); database.close(); database = f.open();
  const before = f.rows(database), version = database.db.prepare("SELECT version FROM memory_clock WHERE id=1").get().version;
  database.db.exec(`CREATE TRIGGER fail_recovery_receipt BEFORE INSERT ON memory_state
    WHEN NEW.namespace='active-memory-recovery' BEGIN SELECT RAISE(ABORT,'isolated recovery receipt failure'); END;`);
  assert.throws(() => recoverActiveMemorySessions(database, "one"), /isolated recovery receipt failure/u);
  assert.deepEqual(f.rows(database), before);
  assert.equal(database.db.prepare("SELECT version FROM memory_clock WHERE id=1").get().version, version);
  assert.equal(database.db.prepare("SELECT count(*) AS n FROM memory_state WHERE namespace=?").get(RECOVERY_NAMESPACE).n, 0);
  database.db.exec("DROP TRIGGER fail_recovery_receipt");
  assert.equal(recoverActiveMemorySessions(database, "one").recovered, 1); assert.deepEqual(f.rows(database), []);
});

test("a bounded recovery scan retains unexamined records instead of claiming cleanup succeeded", async t => {
  const f = fixture(t); let database = f.open();
  const retained = await f.retain(database);
  database.transact(() => {
    const insert = database.db.prepare("INSERT INTO memory_state VALUES (?,?,'{}',0,NULL,1)");
    for (let index = 0; index < 10_001; index++) insert.run(NAMESPACE, `!unverified-${index}`);
  });
  database.close(); database = f.open();
  const result = recoverActiveMemorySessions(database, "one");
  assert.equal(result.scanned, 10_000); assert.equal(result.unresolved, 10_002); assert.equal(result.recovered, 0);
  assert.equal(database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=?").get(NAMESPACE, retained.key).value, retained.value);
  assert.throws(() => f.runtime(database), { code: "MEMORY_ACTIVE_RECOVERY_PENDING" });
});

for (const phase of ["created", "tool"]) test(`SIGKILL after native ${phase} commit is recovered on the next database lifetime without replay`, async t => {
  const f = fixture(t), worker = path.join(__dirname, "fixtures/shoggoth-active-memory-crash-worker.cjs");
  const child = spawn(process.execPath, [worker, f.root, phase], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errorText = ""; child.stderr.on("data", value => { errorText = (errorText + value).slice(-4096); });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  void closed.catch(() => {});
  let timer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => child.once("message", value => value.ready && value.phase === phase ? resolve() : reject(new Error(JSON.stringify(value))))),
      closed.then(() => { throw new Error(`Fixture exited before crash point: ${errorText}`); }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`Fixture not ready: ${errorText}`)), 10_000); }),
    ]);
    clearTimeout(timer); assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
    const database = f.open(), rows = f.rows(database);
    assert.equal(rows.length, 1);
    const record = JSON.parse(rows[0].value); assert.equal(record.events.length, phase === "tool" ? 1 : 0);
    const result = recoverActiveMemorySessions(database, "one");
    assert.equal(result.recovered, 1); assert.equal(result.unresolved, 0); assert.deepEqual(f.rows(database), []);
    assert.equal(fs.readFileSync(f.memory, "utf8"), "Keep the real memory file unchanged.\n");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
  }
});
