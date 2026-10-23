"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) assert.fail(message); await delay(20); }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-watch-manager-"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const workspace = path.join(root, "one");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  const database = new MemoryDatabase({ paths }); database.open();
  let current = true;
  const encodes = [], warnings = [], watchers = [], nativeOwners = [], foregroundSearches = [];
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: { list: () => [] },
    assertCurrent: () => { if (!current) throw Object.assign(new Error("Fixture Profile revoked"), { code: "MEMORY_SCOPE_REVOKED" }); } });
  // Use the public pinned resolver's actual watch default (1500ms). Only its
  // filesystem transport receives the supported isolated polling override.
  const config = { memory: { search: { provider: "shoggoth-e5", sources: ["memory"],
    cache: { enabled: true }, sync: { watch: true } } } };
  const embedding = { identity: "fixture-watch-manager-e5-v1", encode: async (text, purpose) => {
    encodes.push({ text, purpose }); return [1, 0];
  } };
  const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true,
    embedding, getConfig: () => config, backgroundSync: true,
    logger: { debug() {}, warn: message => warnings.push(message) } });
  const nativeWatch = index.sourceFiles.watch;
  index.sourceFiles.watch = function (request, onEvent, signal) {
    const events = [];
    const retirement = nativeWatch.call(this, request, event => { events.push(event); return onEvent(event); }, signal);
    retirement.catch(() => {});
    // The manager's .then() deliberately consumes the host retirement promise;
    // this thin resource capture retains the actual host readiness barrier.
    watchers.push({ request, signal, retirement, events });
    return retirement;
  };
  if (t) {
    const nativeStart = core.MemoryFileWatcher.prototype.start;
    t.mock.method(core.MemoryFileWatcher.prototype, "start", function (...args) {
      nativeOwners.push(this); return nativeStart.apply(this, args);
    });
    const nativeSearch = index.search;
    t.mock.method(index, "search", function (...args) { foregroundSearches.push(args); return nativeSearch.apply(this, args); });
  }
  const saved = { poll: process.env.CHOKIDAR_USEPOLLING, interval: process.env.CHOKIDAR_INTERVAL };
  process.env.CHOKIDAR_USEPOLLING = "true"; process.env.CHOKIDAR_INTERVAL = "40";
  // This isolated constructor has no Service socket. Keep it alive while the
  // native observer's intentionally unref'd settle/debounce work is pending.
  const keepAlive = setInterval(() => {}, 1000);
  let cleanupPromise;
  const f = { root, paths, workspace, database, host, index, config, encodes, warnings, watchers, nativeOwners, foregroundSearches,
    revoke: () => { current = false; },
    write(name, content) { const target = path.join(workspace, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, content, { mode: 0o600 }); },
    source: name => database.db.prepare("SELECT * FROM memory_index_sources WHERE source='memory' AND path=?").get(name),
    text: name => database.db.prepare("SELECT text FROM memory_index_chunks WHERE source='memory' AND path=? ORDER BY start_line").all(name).map(row => row.text).join("\n"),
    revision: () => database.db.prepare("SELECT revision FROM memory_index_state WHERE id=1").get().revision,
    cleanup: () => cleanupPromise ??= (async () => {
      try {
        await index.close();
        await Promise.all(watchers.map(watcher => watcher.retirement));
        assert.equal(host.coordinationDatabases?.size || 0, 0, "the watcher manager must release all physical generation leases");
        for (const owner of nativeOwners) assert.equal(owner.observations.size, 0, "every actual native filesystem subscription must retire");
      } finally {
        clearInterval(keepAlive);
        index.sourceFiles.watch = nativeWatch;
        database.close();
        for (const [name, value] of [["CHOKIDAR_USEPOLLING", saved.poll], ["CHOKIDAR_INTERVAL", saved.interval]]) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    })(),
  };
  t?.after(f.cleanup);
  return f;
}

async function start(f) {
  await f.index.sync();
  assert.equal(f.watchers.length, 1, "the persistent manager alone owns the real memory observer");
  assert.equal(f.watchers[0].request.settings.sync.watchDebounceMs, 1500);
  await f.watchers[0].retirement.ready;
  await until(() => !f.index.searchOwner.syncing && !f.index.searchOwner.activeManagerOperations
    && f.nativeOwners.every(owner => !owner.watchTimer && !owner.settling && !owner.refreshing), "native watcher startup must settle");
  await f.index.tail;
}

if (process.argv.includes("--watch-exit-child")) {
  (async () => {
    const f = fixture();
    try {
      f.write("MEMORY.md", "Child native watcher exit fixture.");
      await f.index.sync();
      assert.equal(f.watchers.length, 1);
      await f.watchers[0].retirement.ready;
      f.revoke();
      await f.cleanup();
      process.stdout.write(JSON.stringify({ phase: "closed", retired: f.watchers.every(watcher => watcher.signal.aborted),
        coordination: f.host.coordinationDatabases?.size || 0 }) + "\n");
      // Exit naturally: no process.exit, retained socket or forced observer kill.
    } finally { await f.cleanup(); }
  })().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
} else {
  test("real native watcher updates changed, new and deleted SQLite sources without a foreground search", { timeout: 25_000 }, async t => {
    const f = fixture(t);
    f.write("MEMORY.md", "Amber baseline.");
    f.write("memory/remove.md", "Silver removable source.");
    await start(f);
    const beforeRevision = f.revision(), beforeEvents = f.watchers[0].events.length;
    f.encodes.length = 0;
    f.write("MEMORY.md", "Indigo changed source.");
    f.write("memory/new.md", "Golden newly created source.");
    fs.unlinkSync(path.join(f.workspace, "memory/remove.md"));
    await until(() => f.text("MEMORY.md").includes("Indigo") && f.text("memory/new.md").includes("Golden")
      && !f.source("memory/remove.md"), "native watcher must publish changed/new/deleted rows without search");
    await f.index.tail;
    assert.ok(f.watchers[0].events.length > beforeEvents);
    assert.ok(f.watchers[0].events.every(event => event === "change"));
    assert.ok(f.revision() > beforeRevision);
    assert.deepEqual(f.encodes.filter(call => call.purpose === "passage").map(call => call.text).sort(),
      ["Golden newly created source.", "Indigo changed source."]);
    assert.equal(f.foregroundSearches.length, 0);
    assert.equal(f.index.searchOwner.memoryWatchUnavailable, false);
    assert.equal(f.watchers.length, 1);
  });

  test("a native watch notification during a force shadow queues a later source pass and restores memory dirty state", { timeout: 25_000 }, async t => {
    const f = fixture(t), entered = deferred(), gate = deferred();
    f.write("MEMORY.md", "Amber force baseline.");
    await start(f);
    const owner = f.index.searchOwner, beforeGeneration = owner.memoryWatchGeneration, beforeEvents = f.watchers[0].events.length;
    const syncSources = f.index.embeddingExecutor.syncSources;
    let shadow;
    t.mock.method(f.index.embeddingExecutor, "syncSources", async function (signal, options) {
      await syncSources.call(this, signal, options);
      if (options?.database?.isShadow && !shadow) {
        shadow = options.database; entered.resolve(); await gate.promise;
      }
    });
    const forced = owner.sync({ force: true, reason: "fixture-force-shadow" });
    forced.catch(() => {});
    try {
      await Promise.race([entered.promise, forced.then(() => { throw new Error("Native force generation completed before its shadow gate"); })]);
      assert.ok(f.index.rebuildOwner, "the real force generation must still own its shadow");
      assert.equal(shadow.db.prepare("SELECT 1 FROM memory_index_sources WHERE path='memory/new.md'").get(), undefined);
      f.write("memory/new.md", "Golden arrived during force shadow.");
      await until(() => f.watchers[0].events.length > beforeEvents && owner.memoryWatchGeneration > beforeGeneration,
        "the actual settled watcher callback must enter native WatchOps while force publication is gated");
      assert.ok(owner.syncing, "watch work must join the older force generation before retrying");
      assert.equal(f.source("memory/new.md"), undefined, "queued watch work cannot mutate the live generation before the force finishes");
      assert.equal(shadow.db.prepare("SELECT 1 FROM memory_index_sources WHERE path='memory/new.md'").get(), undefined,
        "the original completed shadow snapshot must not absorb later watch inputs");
    } finally { gate.resolve(); }
    await forced;
    await until(() => f.text("memory/new.md").includes("Golden arrived during force shadow."),
      "a later actual watch pass must restore dirty state after older full publication consumed it");
    await f.index.tail;
    await until(() => !owner.syncing && !owner.activeManagerOperations, "queued native watch work must drain");
    assert.equal(owner.dirty, false);
    assert.equal(owner.memoryWatchUnavailable, false);
    assert.equal(f.foregroundSearches.length, 0);
    assert.equal(f.watchers.length, 1);
  });

  test("manager close after scope withdrawal waits for physical native observer retirement and rejects later events", { timeout: 15_000 }, async t => {
    const f = fixture(t), entered = deferred(), gate = deferred();
    f.write("MEMORY.md", "Amber close baseline.");
    await start(f);
    const owner = f.index.searchOwner, native = f.nativeOwners[0], entry = native.observations.values().next().value;
    const nativeClose = entry.subscription.close;
    t.mock.method(entry.subscription, "close", async function (...args) {
      await nativeClose.apply(this, args); entered.resolve(); await gate.promise;
    });
    const beforeEvents = f.watchers[0].events.length;
    f.revoke();
    let settled = false;
    const closing = f.index.close();
    closing.then(() => { settled = true; }, () => { settled = true; });
    try {
      await Promise.race([entered.promise, closing.then(() => { throw new Error("Manager close completed before native subscription retirement"); })]);
      assert.equal(f.watchers[0].signal.aborted, true);
      assert.equal(settled, false, "manager close cannot finish before the host physically joins its observer");
      f.write("memory/after-close.md", "This must remain outside the retired index.");
      await delay(150);
      assert.equal(f.watchers[0].events.length, beforeEvents);
    } finally { gate.resolve(); }
    await closing;
    await f.watchers[0].retirement;
    assert.equal(owner.closed, true);
    assert.equal(owner.activeManagerOperations, 0);
    assert.equal(owner.memoryWatchSubscription, undefined);
    assert.equal(owner.remoteWatchRetirement, undefined);
    assert.equal(native.closed, true);
    assert.equal(native.observations.size, 0);
    assert.equal(native.pendingPaths.size, 0);
    assert.equal(native.watchTimer?._destroyed ?? true, true);
    assert.equal(f.source("memory/after-close.md"), undefined);
    assert.equal(f.host.coordinationDatabases?.size || 0, 0);
  });

  test("an isolated process exits naturally after withdrawing scope and closing its real watch manager", { timeout: 20_000 }, async t => {
    const child = spawn(process.execPath, [__filename, "--watch-exit-child"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout = (stdout + bytes.toString()).slice(-8000); });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-8000); });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    let timer;
    try {
      const result = await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Native watcher child did not exit naturally: ${stderr}`)), 15_000);
      })]);
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
      assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), { phase: "closed", retired: true, coordination: 0 });
    } finally { clearTimeout(timer); }
  });
}
