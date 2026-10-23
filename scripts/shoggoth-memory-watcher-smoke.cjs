"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const asyncFs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { withMemoryHost, withMemoryObserverCleanup, callHost } = require("../app/agent-service/shoggoth-memory/host-bridge.cjs");
const { MemorySourceFiles } = require("../app/agent-service/shoggoth-memory/source-files.cjs");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, message) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(20);
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-watcher-"));
  const workspace = path.join(root, "one"), library = path.join(root, "library");
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), profileDir: path.join(root, "profiles"),
    cacheDir: path.join(root, "cache"), runtimeDir: path.join(root, "runtime") };
  const roster = [{ id: "one", workspace }, { id: "two", workspace: path.join(root, "two") }];
  for (const target of [workspace, library, ...Object.values(paths), roster[1].workspace]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const config = { memory: { search: { provider: "none", extraPaths: [library],
    multimodal: { enabled: false, modalities: [] }, sync: { watchDebounceMs: 10 } } } };
  let current = true;
  const events = [], logs = [], owners = [], subscriptions = [];
  const host = { profileId: "one", workspaceDir: workspace, paths, roster: () => roster,
    assertCurrent() { if (!current) throw Object.assign(new Error("Fixture Profile revoked"), { code: "MEMORY_SCOPE_REVOKED" }); },
    assertWorkspace(target) {
      this.assertCurrent(); assert.equal(target, workspace);
      if (fs.realpathSync.native(workspace) !== workspace) throw Object.assign(new Error("Fixture workspace redirected"), { code: "MEMORY_SCOPE_REVOKED" });
    },
    assertSecretOwnerAvailable() {},
    resolveAgentConfig(_cfg, id) { this.assertCurrent(); assert.equal(id, "one"); return {}; },
    log(level, subsystem, message) { logs.push({ level, subsystem, message }); },
    searchIndex: { logger: { warn(message) { logs.push({ level: "warn", message }); } } },
    run(action) { return withMemoryHost(this, action); },
  };
  const source = new MemorySourceFiles(host, () => config);
  const nativeStart = core.MemoryFileWatcher.prototype.start;
  t.mock.method(core.MemoryFileWatcher.prototype, "start", function (...args) {
    owners.push(this); return nativeStart.apply(this, args);
  });
  const saved = { poll: process.env.CHOKIDAR_USEPOLLING, interval: process.env.CHOKIDAR_INTERVAL };
  // Native background timers intentionally unref themselves. This isolated
  // test host owns no Service socket, so retain one fixture-only loop handle.
  const keepAlive = setInterval(() => {}, 1000);
  process.env.CHOKIDAR_USEPOLLING = "true";
  process.env.CHOKIDAR_INTERVAL = "40";
  const f = { root, workspace, library, paths, config, source, events, owners, logs,
    revoke: () => { current = false; },
    write(target, content = "Metadata watcher fixture.") {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { mode: 0o600 });
    },
    watch(overrides = {}) {
      const settings = source.settings(), controller = new AbortController();
      const request = { agentId: "one", settings: { extraPaths: settings.extraPaths, multimodal: settings.multimodal,
        sync: { watchDebounceMs: settings.sync.watchDebounceMs } }, ...overrides };
      const retirement = source.watch(request, event => events.push(event), controller.signal);
      retirement.catch(() => {});
      const subscription = { controller, retirement };
      subscriptions.push(subscription);
      return subscription;
    },
  };
  t.after(async () => {
    for (const subscription of subscriptions) subscription.controller.abort();
    await Promise.allSettled(subscriptions.map(subscription => subscription.retirement));
    clearInterval(keepAlive);
    for (const owner of owners) assert.equal(owner.observations.size, 0, "retirement must join and remove every actual native subscription");
    for (const [name, value] of [["CHOKIDAR_USEPOLLING", saved.poll], ["CHOKIDAR_INTERVAL", saved.interval]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test("native metadata observation sees missing canonical files, memory directories and configured missing extra roots", { timeout: 30_000 }, async t => {
  const f = fixture(t), missingLibrary = path.join(f.root, "late", "library");
  f.config.memory.search.extraPaths = [missingLibrary];
  const { retirement } = f.watch();
  await retirement.ready;
  assert.equal(f.owners.length, 1);
  await delay(250);
  for (const target of [path.join(f.workspace, "MEMORY.md"), path.join(f.workspace, "USER.md"),
    path.join(f.workspace, "memory", "nested", "note.md"), path.join(missingLibrary, "guide.md")]) {
    const before = f.events.length;
    f.write(target);
    await until(() => f.events.length > before, `missing source creation must notify its native owner: ${target}`);
    assert.ok(f.events.every(event => event === "change"));
    await delay(150);
  }
});

test("configured globs and protected subtrees filter real watcher events without loading file contents", { timeout: 20_000 }, async t => {
  const f = fixture(t), protectedRoot = path.join(f.library, "service-runtime");
  f.paths.runtimeDir = protectedRoot;
  f.config.memory.search.extraPaths = [{ path: f.library, pattern: "visible/**/*.md" }];
  const visible = path.join(f.library, "visible", "guide.md"), hidden = path.join(f.library, "hidden", "guide.md"), secret = path.join(protectedRoot, "secret.md");
  for (const target of [visible, hidden, secret]) f.write(target);
  t.mock.method(f.source, "readBytes", () => { throw new Error("Watcher attempted to load file contents"); });
  t.mock.method(f.source, "readForIndexing", () => { throw new Error("Watcher attempted to flatten file contents"); });
  const { retirement } = f.watch();
  await retirement.ready;
  await delay(300);
  const before = f.events.length;
  fs.appendFileSync(hidden, "Hidden update.");
  fs.appendFileSync(secret, "Protected update.");
  await delay(300);
  assert.equal(f.events.length, before);
  fs.appendFileSync(visible, "Admitted update.");
  await until(() => f.events.length > before, "a configured Markdown change must reach the native settled notification");
  assert.ok(f.events.every(event => event === "change"));
});

test("invalid configured roots and foreign Profile requests fail before constructing a native observer", async t => {
  const f = fixture(t), link = path.join(f.root, "library-link"), writable = path.join(f.root, "writable");
  fs.symlinkSync(f.library, link);
  fs.mkdirSync(writable, { mode: 0o777 }); fs.chmodSync(writable, 0o777);
  for (const target of [f.paths.stateDir, path.join(f.root, "two"), link, writable]) {
    f.config.memory.search.extraPaths = [target];
    const { retirement } = f.watch();
    await assert.rejects(retirement.ready, { code: "MEMORY_PATH_NOT_ALLOWED" });
    await assert.rejects(retirement, { code: "MEMORY_PATH_NOT_ALLOWED" });
  }
  f.config.memory.search.extraPaths = [f.library];
  const foreign = f.watch({ agentId: "two" }).retirement;
  await assert.rejects(foreign, { code: "MEMORY_PATH_NOT_ALLOWED" });
  assert.equal(f.owners.length, 0);
});

test("configuration withdrawal and authority withdrawal retire old observers and reject stale notifications", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  f.write(path.join(f.library, "guide.md"));
  const old = f.watch().retirement;
  await old.ready; await delay(250);
  const before = f.events.length;
  f.config.memory.search.extraPaths = [];
  await assert.rejects(old, { code: "MEMORY_SOURCE_CHANGED" });
  fs.appendFileSync(path.join(f.library, "guide.md"), "Revoked update.");
  await delay(200);
  assert.equal(f.events.length, before);
  const current = f.watch().retirement;
  await current.ready;
  f.revoke();
  await assert.rejects(current, { code: "MEMORY_SCOPE_REVOKED" });
  assert.equal(f.owners.every(owner => owner.observations.size === 0), true);
});

test("abort waits for the actual native subscription retirement and prevents events before that join settles", { timeout: 15_000 }, async t => {
  const f = fixture(t), gate = deferred(), closing = deferred();
  f.write(path.join(f.workspace, "MEMORY.md"));
  const { controller, retirement } = f.watch();
  await retirement.ready; await delay(250);
  const owner = f.owners[0], observation = owner.observations.values().next().value, nativeClose = observation.subscription.close;
  t.mock.method(observation.subscription, "close", async function (...args) {
    await nativeClose.apply(this, args);
    closing.resolve();
    await gate.promise;
  });
  let settled = false;
  retirement.then(() => { settled = true; }, () => { settled = true; });
  const before = f.events.length;
  try {
    controller.abort(new Error("Fixture observer cancelled"));
    await closing.promise;
    assert.equal(settled, false, "requesting cancellation alone cannot release the observer's retirement promise");
    fs.appendFileSync(path.join(f.workspace, "MEMORY.md"), "After abort.");
    await delay(200);
    assert.equal(f.events.length, before);
  } finally { gate.resolve(); }
  await retirement;
  assert.equal(owner.observations.size, 0);
  assert.equal(owner.pendingPaths.size, 0);
});

test("native transport retirement failure survives cancellation after physical subscription cleanup", { timeout: 15_000 }, async t => {
  const f = fixture(t), { controller, retirement } = f.watch();
  await retirement.ready;
  const observation = f.owners[0].observations.values().next().value, nativeClose = observation.subscription.close;
  t.mock.method(observation.subscription, "close", async function (...args) {
    await nativeClose.apply(this, args);
    throw new Error("Fixture transport retirement failed");
  });
  controller.abort(new Error("Fixture observer cancelled"));
  await assert.rejects(retirement, error => error instanceof AggregateError
    && error.errors.some(item => /Fixture transport retirement failed/.test(item.message)));
  assert.equal(f.owners[0].observations.size, 0);
});

test("authority withdrawal followed by abort joins the native observer without reentering read authority", { timeout: 15_000 }, async t => {
  const f = fixture(t), { controller, retirement } = f.watch();
  await retirement.ready;
  const owner = f.owners[0], observation = owner.observations.values().next().value, nativeClose = observation.subscription.close;
  let closed = false;
  t.mock.method(observation.subscription, "close", async function (...args) {
    await nativeClose.apply(this, args);
    // Actual native retirement can still emit diagnostics after close. Product
    // source authority is revoked, so this must use only the cleanup scope.
    callHost("log", "warn", "fixture", "Observer physically retired after withdrawal");
    closed = true;
  });
  const before = f.events.length;
  f.revoke();
  controller.abort(new Error("Fixture Service stopped"));
  await retirement;
  assert.equal(closed, true);
  assert.equal(owner.observations.size, 0);
  assert.equal(owner.pendingPaths.size, 0);
  assert.equal(f.events.length, before);
  assert.ok(f.logs.some(item => item.message.includes("Observer physically retired after withdrawal")));
});

test("observer cleanup exposes diagnostics but cannot reacquire source or storage capabilities", async t => {
  const f = fixture(t);
  let storageCalls = 0;
  f.source.host.resolveStorePath = () => { storageCalls++; return path.join(f.root, "private.sqlite"); };
  f.revoke();
  await withMemoryObserverCleanup(f.source.host, async () => {
    await Promise.resolve();
    callHost("log", "warn", "fixture", "Cleanup diagnostic");
    assert.throws(() => callHost("resolveStorePath"), /Memory host capability unavailable: resolveStorePath/);
    assert.throws(() => callHost("assertWorkspace", f.workspace), /Memory host capability unavailable: assertWorkspace/);
  });
  assert.equal(storageCalls, 0);
  assert.ok(f.logs.some(item => item.message.includes("Cleanup diagnostic")));
});

test("a transient failure in actual fs-safe observation retires its subscription and recovers under the same native watcher", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  f.write(path.join(f.workspace, "memory", "note.md"), "Before transient observation failure.");
  const { retirement } = f.watch();
  await retirement.ready;
  const owner = f.owners[0], original = owner.observations.values().next().value;
  const openDirectory = asyncFs.opendir;
  let failures = 0, settled = false;
  retirement.then(() => { settled = true; }, () => { settled = true; });
  t.mock.method(asyncFs, "opendir", async function (directory, ...args) {
    if (!failures && directory === path.join(f.workspace, "memory")) {
      failures++;
      // fs-safe can recover a path-local EIO within a scan. ENOSPC is a
      // transport-wide failure and reaches the native watcher retry owner.
      throw Object.assign(new Error("Fixture temporary observation transport failure"), { code: "ENOSPC" });
    }
    return openDirectory.call(this, directory, ...args);
  });
  await assert.rejects(original.subscription.reconcile(), /Fixture temporary observation transport failure/);
  await until(() => f.events.includes("unavailable"), "an actual observation failure must be forwarded as a metadata unavailable event");
  await until(() => [...owner.observations.values()].some(entry => entry.subscription !== original.subscription
    && entry.subscription.health().state === "ready"), "the original 500ms recovery must install a healthy physical subscription");
  const recovered = [...owner.observations.values()].find(entry => entry.subscription !== original.subscription);
  assert.equal(failures, 1);
  assert.equal(original.subscription.health().state, "closed", "the failed transport must physically retire before reuse");
  assert.equal(recovered.group.root, original.group.root, "bounded recovery must keep its admitted pinned Root");
  assert.equal(f.owners.length, 1, "Product must keep one native watcher owner through recovery");
  assert.equal(owner.capacityDegraded, false);
  assert.equal(owner.closed, false);
  assert.equal(settled, false, "temporary unavailable cannot settle the resource retirement promise");
  await until(() => !owner.watchTimer && !owner.settling && !owner.refreshing,
    "the recovered subscription's initial reconciliation must settle before testing a later edit");
  const before = f.events.filter(event => event === "change").length;
  f.write(path.join(f.workspace, "memory", "after-recovery.md"), "After native observation recovery.");
  await until(() => f.events.filter(event => event === "change").length > before,
    "a changed source after native recovery must still reach the metadata event consumer");
});

test("actual fs-safe watch capacity failure permanently retires subscriptions while retaining the manager resource until abort", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  f.write(path.join(f.workspace, "memory", "note.md"), "Before capacity failure.");
  const { controller, retirement } = f.watch();
  await retirement.ready;
  const owner = f.owners[0], original = owner.observations.values().next().value;
  // Reuse the actual fs-safe error type already owned by this pinned Root.
  // An invalid path fails before any source is opened or any outside read.
  let FsSafeError;
  try { await original.group.root.open("/outside-fixture"); assert.fail("absolute Root paths must be rejected"); }
  catch (error) { assert.equal(error.name, "FsSafeError"); FsSafeError = error.constructor; }
  const capacity = new FsSafeError("helper-failed", "Fixture native watch capacity exhausted", {
    details: { operation: "watch", code: "watch-limit" },
  });
  const openDirectory = asyncFs.opendir;
  let failures = 0, settled = false;
  retirement.then(() => { settled = true; }, () => { settled = true; });
  t.mock.method(asyncFs, "opendir", async function (directory, ...args) {
    if (!failures && directory === path.join(f.workspace, "memory")) { failures++; throw capacity; }
    return openDirectory.call(this, directory, ...args);
  });
  await assert.rejects(original.subscription.reconcile(), error => error === capacity);
  await until(() => owner.capacityDegraded && owner.observations.size === 0 && !owner.recovering,
    "the native watch-limit path must physically retire subscriptions and become sticky");
  assert.ok(f.events.includes("unavailable"));
  assert.equal(original.subscription.health().state, "closed");
  assert.equal(owner.retryTimer, undefined, "capacity exhaustion must not arm the 500ms transient retry");
  assert.equal(owner.closed, false, "capacity state belongs to the existing native owner until cancellation");
  assert.equal(settled, false);
  const before = f.events.filter(event => event === "change").length;
  await until(() => !owner.watchTimer && !owner.settling, "the final capacity dirty notification must settle");
  const settledChanges = f.events.filter(event => event === "change").length;
  assert.ok(settledChanges >= before);
  f.write(path.join(f.workspace, "memory", "after-capacity.md"), "No subscription may resume after capacity failure.");
  await delay(650);
  assert.equal(owner.observations.size, 0);
  assert.equal(owner.retryTimer, undefined);
  assert.equal(f.events.filter(event => event === "change").length, settledChanges);
  controller.abort();
  await retirement;
  assert.equal(owner.closed, true);
});
