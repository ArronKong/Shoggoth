"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { openDatabase } = require("../app/agent-service/inspiration-database");

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-generation-"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") }, workspace = path.join(root, "one");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const database = new MemoryDatabase({ paths }); database.open();
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace, roster: () => [{ id: "one", workspace }] });
  const releases = [], children = [];
  const f = { root, database, host, run: action => host.run(action),
    read: async (signal, fused = false) => {
      const release = await host.run(() => core.acquireMemoryIndexReadGeneration(database.path, signal, fused));
      let active = true;
      const once = async () => { if (active) { active = false; await release(); } };
      releases.push(once); return once;
    },
    publish: action => host.run(() => core.withMemoryIndexPublishGeneration(database.path, action)),
    mutate: action => host.run(() => core.withMemoryIndexMutationGeneration(database.path, action)),
    child: kind => {
      const child = spawn(process.execPath, [path.join(__dirname, "fixtures/memory-index-generation-child.cjs"), root, kind],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      const phases = new Set(), waiting = new Map(); let stderr = "";
      child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-8000); });
      child.on("message", message => { phases.add(message.phase); waiting.get(message.phase)?.resolve(); });
      const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
      const value = { child, exited, phases, phase: async phase => {
        if (phases.has(phase)) return;
        const gate = waiting.get(phase) || deferred(); waiting.set(phase, gate);
        await Promise.race([gate.promise, exited.then(result => { throw new Error(`Child exited before ${phase}: ${JSON.stringify(result)} ${stderr}`); })]);
      } };
      children.push(value); return value;
    } };
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    await Promise.all(releases.map(release => release()));
    assert.equal(host.coordinationDatabases?.size || 0, 0, "all admitted native SQLite lease connections must close");
    database.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test("native publication waits for readers and later readers cannot overtake the queued publisher", async t => {
  const f = fixture(t), first = await f.read(), entered = deferred(), gate = deferred(), order = [];
  const publisher = f.publish(async () => { order.push("publisher"); entered.resolve(); await gate.promise; });
  const reader = f.read().then(release => { order.push("reader"); return release(); });
  try {
    await tick(); assert.deepEqual(order, []); await first(); await entered.promise;
    assert.deepEqual(order, ["publisher"]);
  } finally { gate.resolve(); }
  await Promise.all([publisher, reader]); assert.deepEqual(order, ["publisher", "reader"]);
});

test("plain native retrieval permits mutation while fused retrieval excludes it", async t => {
  const f = fixture(t), first = await f.read(); let writes = 0;
  await f.mutate(async () => { writes++; }); assert.equal(writes, 1); await first();
  const fused = await f.read(undefined, true), pending = f.mutate(async () => { writes++; });
  await tick(); assert.equal(writes, 1); await fused(); await pending; assert.equal(writes, 2);
});

test("cancelling a queued native reader releases admission without disturbing the current publisher", async t => {
  const f = fixture(t), entered = deferred(), gate = deferred(), controller = new AbortController();
  const publisher = f.publish(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  try {
    const reader = f.read(controller.signal); controller.abort(new Error("fixture cancelled"));
    await assert.rejects(reader, /generation lease acquisition aborted/);
    assert.ok(f.host.coordinationDatabases.size > 0);
  } finally { gate.resolve(); }
  await publisher; const next = await f.read(); await next();
});

test("coordination capability rejects foreign paths, SQLite extensions and unsafe file identities", async t => {
  const f = fixture(t), lease = `${f.database.path}.generation-lock.sqlite`, source = path.join(f.root, "unrelated.sqlite");
  fs.writeFileSync(source, "fixture sentinel", { mode: 0o600 });
  assert.throws(() => f.host.openNodeSqliteDatabase(source), { code: "MEMORY_LEASE_DATABASE_INVALID" });
  assert.throws(() => f.host.openNodeSqliteDatabase(lease, { allowExtension: true }), { code: "MEMORY_LEASE_DATABASE_INVALID" });
  fs.symlinkSync(source, lease); await assert.rejects(f.read()); fs.unlinkSync(lease);
  fs.linkSync(source, lease); await assert.rejects(f.read()); fs.unlinkSync(lease);
  fs.writeFileSync(lease, "", { mode: 0o644 }); await assert.rejects(f.read()); fs.unlinkSync(lease);
  assert.equal(fs.readFileSync(source, "utf8"), "fixture sentinel");
  const release = await f.read(); await release();
  assert.equal(fs.statSync(lease).mode & 0o777, 0o600);
});

test("a WAL-mode file cannot silently disable the native coordination lock semantics", async t => {
  const f = fixture(t), lease = `${f.database.path}.generation-writer.sqlite`;
  const db = openDatabase(lease); db.exec("CREATE TABLE fixture (value TEXT)"); db.close();
  const before = fs.readFileSync(lease);
  await assert.rejects(f.read(), { code: "MEMORY_LEASE_DATABASE_INVALID" });
  assert.deepEqual(fs.readFileSync(lease), before);
});

test("a separate Electron process cannot publish while a native reader holds the generation", { timeout: 15000 }, async t => {
  const f = fixture(t), release = await f.read(), child = f.child("publish");
  await child.phase("generation-requested"); assert.equal(child.phases.has("acquired"), false);
  await release(); await child.phase("acquired"); child.child.send("release");
  assert.deepEqual(await child.exited, { code: 0, signal: null });
});

test("SQLite releases a crashed reader process so the waiting publication can complete", { timeout: 15000 }, async t => {
  const f = fixture(t), child = f.child("read"); await child.phase("acquired");
  const requested = deferred(), open = f.host.openNodeSqliteDatabase.bind(f.host);
  f.host.openNodeSqliteDatabase = (...args) => {
    const db = open(...args); if (args[0].endsWith(".generation-lock.sqlite")) requested.resolve(); return db;
  };
  let published = false;
  const publisher = f.publish(async () => { published = true; });
  await requested.promise; assert.equal(published, false);
  child.child.kill("SIGKILL"); assert.equal((await child.exited).signal, "SIGKILL");
  await publisher; assert.equal(published, true);
  const release = await f.read(); await release();
});
