#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ModelOperationRecoveryStore } = require("../app/model-operation-recovery-store");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
const { createEntry, createModelChangeJournal } = require("../app/core/model-change-journal");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const identity = (id = "original-operation", backendId = "openclaw", providerKey = "test-provider") =>
  ({ version: 1, backendId, providerKey, operationId: id });
const row = (id = "original-operation", status = "unconfirmed", code) =>
  ({ ...identity(id), status, ...(code ? { code } : {}) });
const terminal = (id = "original-operation", status = "applied") =>
  ({ ...identity(id), status, stage: "verify-ready", terminal: true });
const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const snapshot = (operations, revision = operations.length) => ({ version: 1, revision, operations });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sgh-model-recovery-store-"));
  const directory = path.join(root, "model-operation-recovery");
  const file = path.join(directory, "identities.json");
  const calls = [];
  let observe = options.observe || ((_backend, request) => terminal(request.operationId));
  const coordinator = { observeOperation(backend, request) { calls.push({ backend, request }); return observe(backend, request); } };
  const stores = [];
  const make = (extra = {}) => {
    const store = new ModelOperationRecoveryStore({ userDataRoot: root, coordinator, ...extra });
    stores.push(store);
    return store;
  };
  return { root, directory, file, calls, coordinator, make, setObserve(fn) { observe = fn; },
    seed(value) { fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(file, bytes(value), { mode: 0o600 }); },
    async cleanup() { await Promise.all(stores.map(store => store.close())); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

async function rejected(action, code) {
  await assert.rejects(action, code ? { code } : undefined);
}

function injectFileSystem() {
  const injected = Object.create(fs);
  return injected;
}

// Actual disk and journal behavior, never App userData, keys, backends or Hosts.
test("private durable initialization and new instance reopen preserve an original identity and monotonic recovery marker", async () => {
  const f = fixture();
  try {
    const first = f.make();
    assert.deepEqual(await first.open(), snapshot([], 0));
    assert.equal(fs.statSync(f.directory).mode & 0o7777, 0o700);
    assert.equal(fs.statSync(f.file).mode & 0o7777, 0o600);
    assert.equal(fs.statSync(f.file).nlink, 1);
    const retained = await first.retain(row("persisted-id", "cleanup_pending", "model_recovery_requested"));
    assert.equal(retained.revision, 1);
    await first.retain(row("persisted-id", "in_progress"));
    assert.equal((await first.read()).operations[0].code, "model_recovery_requested");
    await first.close();
    const second = f.make();
    const reopened = await second.open();
    assert.equal(reopened.revision, 2);
    assert.deepEqual(reopened.operations, [row("persisted-id", "in_progress", "model_recovery_requested")]);
    assert.deepEqual(f.calls, []);
    assert.equal(Object.isFrozen(reopened.operations[0]), true);
  } finally { await f.cleanup(); }
});

test("retain captures a closed bounded DTO before enqueue and rejects secrets, symbols, getters and unsafe statuses without touching disk", async () => {
  const f = fixture();
  try {
    const store = f.make(); await store.open();
    const value = row("captured-original");
    const retaining = store.retain(value); value.operationId = "mutated-after-dispatch";
    await retaining;
    const before = fs.readFileSync(f.file);
    let getters = 0;
    const getter = { ...row() };
    Object.defineProperty(getter, "operationId", { enumerable: true, get() { getters++; return "getter-id"; } });
    const hidden = { ...row() }; Object.defineProperty(hidden, "hidden", { value: "private" });
    const inherited = Object.create(row());
    for (const value of [null, [], inherited, getter, hidden, { ...row(), apiKey: "canary-key" },
      { ...row(), requestDigest: "canary-digest" }, { ...row(), ref: "canary-ref" }, { ...row(), [Symbol("secret")]: true },
      { ...row(), code: "renderer_error" }, { ...row(), version: 2 }, row("x".repeat(129)), row("bad/id"),
      { ...row(), providerKey: "bad:provider" }, { ...row(), backendId: "bad/backend" }, row("terminal", "applied"),
      row("credential-layer", "needs_verification")]) {
      await rejected(store.retain(value), "model_recovery_invalid");
    }
    assert.equal(getters, 0);
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal((await store.read()).operations[0].operationId, "captured-original");
    assert.equal(before.includes("canary"), false);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test("serial concurrent retains/read have durable ordered revisions and repeated identical retention performs zero writes", async () => {
  const f = fixture(); const injected = injectFileSystem(); let writes = 0;
  injected.writeSync = (...args) => { writes++; return fs.writeSync(...args); };
  try {
    const store = f.make({ fs: injected }); await store.open();
    const first = store.retain(row("concurrent-first"));
    const second = store.retain(row("concurrent-second", "partial"));
    const reading = store.read();
    assert.equal((await first).revision, 1); assert.equal((await second).revision, 2);
    const state = await reading;
    assert.deepEqual(state.operations.map(value => value.operationId), ["concurrent-first", "concurrent-second"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), state);
    const count = writes, before = fs.readFileSync(f.file);
    assert.equal((await store.retain(row("concurrent-second", "partial"))).revision, 2);
    assert.equal(writes, count); assert.deepEqual(fs.readFileSync(f.file), before);
  } finally { await f.cleanup(); }
});

test("one live store owns the fixed root, while close permits a fresh instance and closed stores remain unavailable", async () => {
  const f = fixture();
  try {
    const first = f.make(), overlapping = f.make(); await first.open();
    await rejected(overlapping.open(), "model_recovery_already_open");
    await first.retain(row("survives-close")); await first.close();
    await rejected(first.read(), "model_recovery_unavailable");
    await rejected(first.retain(row("closed-write")), "model_recovery_unavailable");
    const second = f.make(); assert.equal((await second.open()).operations[0].operationId, "survives-close");
  } finally { await f.cleanup(); }
});

test("close drains already-enqueued writes, rejects new calls immediately and permits a fresh durable reopen", async () => {
  const f = fixture();
  try {
    const store = f.make(); await store.open();
    const retaining = store.retain(row("before-close-original"));
    const reading = store.read();
    const closing = store.close();
    await rejected(store.retain(row("after-close-original")), "model_recovery_unavailable");
    await rejected(store.read(), "model_recovery_unavailable");
    assert.equal((await retaining).operation.operationId, "before-close-original");
    assert.equal((await reading).operations[0].operationId, "before-close-original");
    await closing;
    const next = f.make(); assert.equal((await next.open()).operations[0].operationId, "before-close-original");
  } finally { await f.cleanup(); }
});

test("an operation ID cannot be rebound to another backend/provider and an ACK scope mismatch calls no coordinator", async () => {
  const f = fixture();
  try {
    const store = f.make(); await store.open(); await store.retain(row());
    const before = fs.readFileSync(f.file);
    for (const patch of [{ backendId: "hermes" }, { providerKey: "other-provider" }]) {
      await rejected(store.retain({ ...row(), ...patch }), "model_recovery_scope_mismatch");
      await rejected(store.ack({ ...identity(), ...patch }), "model_recovery_scope_mismatch");
    }
    assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.file), before);
    await store.retain({ ...row("second-original"), providerKey: "test-provider" });
    assert.equal((await store.read()).operations.length, 2);
  } finally { await f.cleanup(); }
});

test("ACK accepts only exact original terminal receipts and accurate outcomes, and a lost ACK can be rechecked with zero further write", async () => {
  const f = fixture(); const injected = injectFileSystem(); let writes = 0;
  injected.writeSync = (...args) => { writes++; return fs.writeSync(...args); };
  try {
    const store = f.make({ fs: injected }); await store.open();
    for (const outcome of ["applied", "failed", "compensated"]) {
      const id = `terminal-${outcome}`; await store.retain(row(id, "cleanup_pending", "model_recovery_requested"));
      f.setObserve((_backend, request) => terminal(request.operationId, outcome));
      const ack = await store.ack(identity(id));
      assert.deepEqual(ack, { version: 1, revision: (outcome === "applied" ? 2 : outcome === "failed" ? 4 : 6),
        ...identity(id), status: "acknowledged", outcome });
      const before = fs.readFileSync(f.file), count = writes;
      assert.deepEqual(await store.ack(identity(id)), ack);
      assert.equal(writes, count); assert.deepEqual(fs.readFileSync(f.file), before);
    }
    assert.equal(f.calls.length, 6); assert.equal((await store.read()).operations.length, 0);
  } finally { await f.cleanup(); }
});

test("nonterminal, wrong identity, unknown status, async/unsafe and errored journal receipts never delete retained IDs", async () => {
  const f = fixture();
  try {
    const store = f.make(); await store.open(); await store.retain(row("unverified-original", "cleanup_pending"));
    const before = fs.readFileSync(f.file), good = terminal("unverified-original"); let getters = 0;
    const getter = { ...good }; Object.defineProperty(getter, "status", { enumerable: true, get() { getters++; return "applied"; } });
    const values = [null, [], Promise.resolve(good), { ...good, operationId: "foreign-original" },
      { ...good, providerKey: "foreign-provider" }, { ...good, backendId: "hermes" }, { ...good, version: 2 },
      { ...good, terminal: false }, { ...good, status: "pending" }, { ...good, status: "cleanup_pending" },
      { ...good, status: "not_found", terminal: false }, { ...good, stage: "bad/stage" }, { ...good, code: "bad/code" },
      { ...good, apiKey: "canary-receipt-secret" }, { ...good, [Symbol("secret")]: true }, getter,
      { ...good, operationId: undefined }];
    for (const value of values) { f.setObserve(() => value); await rejected(store.ack(identity("unverified-original")), "model_recovery_receipt_unverified"); }
    f.setObserve(() => { throw new Error("canary-private-journal-error"); });
    await rejected(store.ack(identity("unverified-original")), "model_recovery_receipt_unverified");
    assert.equal(getters, 0); assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal((await store.read()).operations[0].operationId, "unverified-original");
    const calls = f.calls.length;
    await rejected(store.ack({ ...identity("unverified-original"), receipt: good }), "model_recovery_invalid");
    assert.equal(f.calls.length, calls);
  } finally { await f.cleanup(); }
});

test("real ModelChangeCoordinator durable journal authorizes ACK before readiness with zero backend calls or journal writes", async () => {
  const f = fixture();
  try {
    const journalFile = path.join(f.root, "model-change-journal.json");
    const journal = createModelChangeJournal(journalFile); const effects = [];
    const registry = { _activeGet() { effects.push("backend"); throw new Error("no backend allowed"); },
      listModelsSnapshot() { effects.push("catalog"); throw new Error("no catalog allowed"); } };
    for (const status of ["applied", "failed", "compensated", "cleanup_pending"]) {
      const id = `real-${status}`;
      await journal.withExclusiveLock(`seed:${id}`, () => {
        journal.begin(createEntry({ operationId: id, backendId: "openclaw", providerKey: "test-provider", kind: "create",
          requestDigest: digest(id), previewTokenDigest: digest(`preview:${id}`), source: null,
          target: { provider: "test-provider", modelId: "private-model" }, modelDiff: { before: null, after: { id: "private-model" } },
          fingerprints: { privateRef: "canary-private-reference" } }));
        journal.finish(id, status, { operationId: id, status, stage: "verify-ready" });
      });
    }
    const coordinator = new ModelChangeCoordinator({ journal: createModelChangeJournal(journalFile), registry, tokenSecret: Buffer.alloc(32, 7) });
    assert.equal(coordinator.isReady(), false);
    const store = f.make({ coordinator }); await store.open();
    const before = fs.readFileSync(journalFile);
    for (const status of ["applied", "failed", "compensated"]) {
      await store.retain(row(`real-${status}`)); assert.equal((await store.ack(identity(`real-${status}`))).outcome, status);
    }
    await store.retain(row("real-cleanup_pending", "cleanup_pending"));
    await rejected(store.ack(identity("real-cleanup_pending")), "model_recovery_receipt_unverified");
    // An ID the coordinator never admitted (and is not processing) settles as a
    // read-only "not admitted" failure: it can be acknowledged, never as success.
    assert.equal((await store.ack(identity("real-absent"))).outcome, "failed");
    await rejected(store.ack(identity("real-applied", "hermes")), "model_recovery_receipt_unverified");
    assert.deepEqual(fs.readFileSync(journalFile), before); assert.deepEqual(effects, []);
    assert.equal(fs.readFileSync(f.file).includes("canary"), false); assert.equal(fs.readFileSync(f.file).includes("private-model"), false);
  } finally { await f.cleanup(); }
});

test("512 operations and revision exhaustion reject further writes while all original records remain intact", async () => {
  const f = fixture();
  try {
    f.seed(snapshot(Array.from({ length: 512 }, (_, index) => row(`bounded-${index}`)), 512));
    const store = f.make(); await store.open(); const before = fs.readFileSync(f.file);
    await rejected(store.retain(row("overflow-original")), "model_recovery_capacity");
    assert.equal((await store.read()).operations.length, 512); assert.deepEqual(fs.readFileSync(f.file), before);
    await store.retain(row("bounded-0", "partial")); assert.equal((await store.read()).revision, 513);
    await store.close();
    fs.writeFileSync(f.file, bytes(snapshot([row("revision-max")], Number.MAX_SAFE_INTEGER)));
    const next = f.make(); await next.open(); const maxBefore = fs.readFileSync(f.file);
    await rejected(next.retain(row("revision-max", "partial")), "model_recovery_capacity");
    await rejected(next.ack(identity("revision-max")), "model_recovery_capacity");
    assert.deepEqual(fs.readFileSync(f.file), maxBefore);
  } finally { await f.cleanup(); }
});

test("corrupt, duplicate/cross-scope, unknown fields and oversized persisted records fail open instead of becoming an empty list", async () => {
  const cases = ["{broken", '{"version":2,"version":1,"revision":0,"operations":[]}\n', bytes({ ...snapshot([row()]), apiKey: "canary-persisted-key" }),
    bytes(snapshot([row(), row()])), bytes(snapshot([row(), { ...row(), backendId: "hermes" }])),
    bytes(snapshot([row("bad-status", "applied")])), bytes(snapshot([row("unsafe-code", "unconfirmed", "private-error")])),
    bytes(snapshot(Array.from({ length: 513 }, (_, index) => row(`large-${index}`)))), Buffer.alloc(384 * 1024 + 1, 32)];
  for (const value of cases) {
    const f = fixture();
    try {
      fs.mkdirSync(f.directory, { mode: 0o700 }); fs.writeFileSync(f.file, value, { mode: 0o600 });
      const before = fs.readFileSync(f.file), store = f.make();
      await rejected(store.open()); await rejected(store.read(), "model_recovery_unavailable");
      assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(f.calls, []);
    } finally { await f.cleanup(); }
  }
});

test("wide/special file/root permissions and symlink/hardlink/type substitutions fail without permission repair or deletion", async () => {
  for (const kind of ["root-wide", "root-special", "file-wide", "file-special", "root-link", "file-link", "file-hardlink", "file-directory"]) {
    const f = fixture();
    try {
      const foreign = path.join(f.root, "foreign");
      if (kind === "root-link") {
        fs.mkdirSync(foreign, { mode: 0o700 }); fs.symlinkSync(foreign, f.directory);
      } else {
        f.seed(snapshot([row("private-original")]));
        if (kind === "root-wide") fs.chmodSync(f.directory, 0o755);
        if (kind === "root-special") fs.chmodSync(f.directory, 0o1700);
        if (kind === "file-wide") fs.chmodSync(f.file, 0o644);
        if (kind === "file-special") fs.chmodSync(f.file, 0o1600);
        if (kind === "file-link") { fs.renameSync(f.file, foreign); fs.symlinkSync(foreign, f.file); }
        if (kind === "file-hardlink") fs.linkSync(f.file, foreign);
        if (kind === "file-directory") { fs.unlinkSync(f.file); fs.mkdirSync(f.file, { mode: 0o700 }); }
      }
      const rootMode = fs.lstatSync(f.directory).mode;
      const fileMode = fs.existsSync(f.file) ? fs.lstatSync(f.file).mode : null;
      const store = f.make(); await rejected(store.open());
      assert.equal(fs.lstatSync(f.directory).mode, rootMode);
      if (fileMode !== null) assert.equal(fs.lstatSync(f.file).mode, fileMode);
      if (kind === "file-hardlink") assert.equal(fs.lstatSync(f.file).nlink, 2);
    } finally { await f.cleanup(); }
  }
});

test("foreign ownership is rejected using controlled stat metadata without requiring root privileges", async () => {
  for (const target of ["root", "file"]) {
    const f = fixture(); const injected = injectFileSystem();
    try {
      f.seed(snapshot([row("owned-original")]));
      const chosen = target === "root" ? f.directory : f.file;
      injected.lstatSync = value => { const stat = fs.lstatSync(value); if (value === chosen) stat.uid = (process.getuid?.() || 0) + 1; return stat; };
      const store = f.make({ fs: injected }); await rejected(store.open());
      assert.equal(JSON.parse(fs.readFileSync(f.file)).operations[0].operationId, "owned-original");
    } finally { await f.cleanup(); }
  }
});

test("root/trusted-root/file identity replacement, in-place changes and unexpected deletion lock a live store with old IDs intact", async () => {
  for (const kind of ["root-replace", "trusted-replace", "file-replace", "inplace-tamper", "deleted", "mode-widen", "hardlinked"]) {
    const f = fixture();
    let movedRoot;
    try {
      const store = f.make(); await store.open(); await store.retain(row("fenced-original"));
      const old = fs.readFileSync(f.file);
      if (kind === "root-replace") {
        fs.renameSync(f.directory, `${f.directory}.original`); fs.mkdirSync(f.directory, { mode: 0o700 }); fs.writeFileSync(f.file, old, { mode: 0o600 });
      }
      if (kind === "trusted-replace") {
        movedRoot = `${f.root}.original`; fs.renameSync(f.root, movedRoot); fs.mkdirSync(f.root, { mode: 0o700 });
        fs.mkdirSync(f.directory, { mode: 0o700 }); fs.writeFileSync(f.file, old, { mode: 0o600 });
      }
      if (kind === "file-replace") { fs.renameSync(f.file, `${f.file}.original`); fs.writeFileSync(f.file, old, { mode: 0o600 }); }
      if (kind === "inplace-tamper") fs.writeFileSync(f.file, bytes(snapshot([row("foreign-original")], 1)));
      if (kind === "deleted") fs.unlinkSync(f.file);
      if (kind === "mode-widen") fs.chmodSync(f.file, 0o644);
      if (kind === "hardlinked") fs.linkSync(f.file, path.join(f.root, "foreign-hardlink"));
      await rejected(store.read(), "model_recovery_unavailable");
      await rejected(store.retain(row("must-not-overwrite")), "model_recovery_unavailable");
      await rejected(store.ack(identity("fenced-original")), "model_recovery_unavailable");
      assert.deepEqual(f.calls, []);
      if (kind === "root-replace") assert.deepEqual(fs.readFileSync(path.join(`${f.directory}.original`, "identities.json")), old);
      if (kind === "file-replace") assert.deepEqual(fs.readFileSync(`${f.file}.original`), old);
      if (kind === "trusted-replace") assert.deepEqual(fs.readFileSync(path.join(movedRoot, "model-operation-recovery", "identities.json")), old);
    } finally { await f.cleanup(); if (movedRoot) fs.rmSync(movedRoot, { recursive: true, force: true }); }
  }
});

test("safe interrupted precommit backup/temp evidence reopens original data, but uncertain or ambiguous evidence remains untouched", async () => {
  for (const kind of ["precommit", "uncertain", "ambiguous", "unsafe-temp", "temp-only-missing-target"]) {
    const f = fixture();
    try {
      f.seed(snapshot([row("crash-original")]));
      const backup = `${f.file}.backup-${process.pid}-0123456789abcdef`;
      const temp = `${f.file}.tmp`;
      if (kind === "precommit") { fs.linkSync(f.file, backup); fs.writeFileSync(temp, bytes(snapshot([row("not-committed")], 2)), { mode: 0o600 }); }
      if (kind === "uncertain") fs.writeFileSync(backup, bytes(snapshot([row("previous-original")])), { mode: 0o600 });
      if (kind === "ambiguous") { fs.linkSync(f.file, backup); fs.writeFileSync(`${f.file}.backup-${process.pid}-fedcba9876543210`, "{}", { mode: 0o600 }); }
      if (kind === "unsafe-temp") fs.writeFileSync(temp, "{}", { mode: 0o644 });
      if (kind === "temp-only-missing-target") { fs.unlinkSync(f.file); fs.writeFileSync(temp, bytes(snapshot([row("unconfirmed-new")], 1)), { mode: 0o600 }); }
      const store = f.make();
      if (kind === "precommit") {
        assert.equal((await store.open()).operations[0].operationId, "crash-original");
        assert.equal(fs.existsSync(backup), false); assert.equal(fs.existsSync(temp), false); assert.equal(fs.statSync(f.file).nlink, 1);
      } else {
        const original = fs.existsSync(f.file) ? fs.readFileSync(f.file) : null;
        await rejected(store.open()); await rejected(store.read(), "model_recovery_unavailable");
        if (original) assert.deepEqual(fs.readFileSync(f.file), original);
        if (kind === "uncertain" || kind === "ambiguous") assert.equal(fs.existsSync(backup), true);
      }
    } finally { await f.cleanup(); }
  }
});

test("short writes are completed before the durability receipt and zero-progress writes retain the prior file", async () => {
  const f = fixture(); const injected = injectFileSystem(); let mode = "short", writeCalls = 0;
  injected.writeSync = (fd, buffer, offset, length, position) => {
    writeCalls++;
    if (mode === "zero") return 0;
    return fs.writeSync(fd, buffer, offset, Math.min(length, 7), position);
  };
  try {
    const store = f.make({ fs: injected }); await store.open(); await store.retain(row("short-write-original"));
    assert(writeCalls > 10); const before = fs.readFileSync(f.file); mode = "zero";
    await rejected(store.retain(row("not-durable")), "model_recovery_save_failed");
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal((await store.read()).operations[0].operationId, "short-write-original");
    mode = "short"; await store.retain(row("after-known-rollback"));
    assert.equal((await store.read()).operations.length, 2);
  } finally { await f.cleanup(); }
});

test("write/file-fsync/rename and first directory-fsync failures with proven rollback never erase the previous durable identity", async () => {
  for (const fault of ["write", "file-fsync", "rename", "directory-fsync"]) {
    const f = fixture(); const injected = injectFileSystem(); let armed = false, directorySyncs = 0;
    injected.writeSync = (...args) => { if (armed && fault === "write") throw Object.assign(Error("canary-write-error"), { code: "EIO" }); return fs.writeSync(...args); };
    injected.renameSync = (...args) => { if (armed && fault === "rename" && args[0] === `${f.file}.tmp`) throw Object.assign(Error("canary-rename-error"), { code: "EIO" }); return fs.renameSync(...args); };
    injected.fsyncSync = fd => {
      const isDirectory = fs.fstatSync(fd).isDirectory();
      if (armed && !isDirectory && fault === "file-fsync") throw Object.assign(Error("canary-fsync-error"), { code: "EIO" });
      if (armed && isDirectory && ++directorySyncs === 1 && fault === "directory-fsync") throw Object.assign(Error("canary-directory-error"), { code: "EIO" });
      return fs.fsyncSync(fd);
    };
    try {
      const store = f.make({ fs: injected }); await store.open(); await store.retain(row("fault-original"));
      const before = fs.readFileSync(f.file); armed = true;
      await rejected(store.ack(identity("fault-original")), "model_recovery_save_failed");
      armed = false; assert.deepEqual(fs.readFileSync(f.file), before);
      assert.equal((await store.read()).operations[0].operationId, "fault-original");
      assert.equal(fs.statSync(f.file).nlink, 1);
      assert.equal(fs.readdirSync(f.directory).length, 1);
      assert.equal((await store.ack(identity("fault-original"))).outcome, "applied");
    } finally { await f.cleanup(); }
  }
});

test("a failed rollback leaves evidence and poisons the store; fresh open cannot infer a confirmed commit or empty state", async () => {
  const f = fixture(); const injected = injectFileSystem(); let armed = false;
  injected.fsyncSync = fd => { if (armed && fs.fstatSync(fd).isDirectory()) throw Object.assign(Error("unconfirmed-durability"), { code: "EIO" }); return fs.fsyncSync(fd); };
  injected.renameSync = (...args) => { if (armed && args[0].includes(".backup-")) throw Object.assign(Error("rollback-not-confirmed"), { code: "EIO" }); return fs.renameSync(...args); };
  try {
    const store = f.make({ fs: injected }); await store.open(); await store.retain(row("uncertain-original")); armed = true;
    await rejected(store.ack(identity("uncertain-original")), "model_recovery_commit_unknown");
    await rejected(store.read(), "model_recovery_unavailable");
    await rejected(store.retain(row("must-not-follow-unknown")), "model_recovery_unavailable");
    const backup = fs.readdirSync(f.directory).find(name => name.includes(".backup-"));
    assert(backup); assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, backup))).operations[0].operationId, "uncertain-original");
    await store.close(); const reopened = f.make(); await rejected(reopened.open(), "model_recovery_commit_unknown");
    assert.equal(fs.existsSync(path.join(f.directory, backup)), true);
  } finally { await f.cleanup(); }
});

test("committed cleanup failure returns unknown and locks the live store, while a fresh instance rechecks the lawful complete file", async () => {
  const f = fixture(); const injected = injectFileSystem(); let armed = false, directorySyncs = 0;
  injected.fsyncSync = fd => {
    if (armed && fs.fstatSync(fd).isDirectory() && ++directorySyncs === 2) throw Object.assign(Error("cleanup-durability-unknown"), { code: "EIO" });
    return fs.fsyncSync(fd);
  };
  try {
    const store = f.make({ fs: injected }); await store.open(); await store.retain(row("cleanup-old")); armed = true;
    await rejected(store.retain(row("cleanup-new")), "model_recovery_commit_unknown");
    await rejected(store.read(), "model_recovery_unavailable");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).operations.map(value => value.operationId), ["cleanup-old", "cleanup-new"]);
    await store.close(); const reopened = f.make();
    assert.deepEqual((await reopened.open()).operations.map(value => value.operationId), ["cleanup-old", "cleanup-new"]);
  } finally { await f.cleanup(); }
});

test("filesystem read errors stay unknown and do not clear retained IDs or become an empty snapshot", async () => {
  const f = fixture(); const injected = injectFileSystem(); let armed = false;
  injected.readFileSync = (...args) => { if (armed) throw Object.assign(Error("canary-private-read-error"), { code: "EIO" }); return fs.readFileSync(...args); };
  try {
    const store = f.make({ fs: injected }); await store.open(); await store.retain(row("unreadable-original"));
    const before = fs.readFileSync(f.file); armed = true;
    await rejected(store.read(), "model_recovery_unavailable");
    await rejected(store.ack(identity("unreadable-original")), "model_recovery_unavailable");
    assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test("root replacement inside the trusted journal callback is caught before deletion, preserving the original root file", async () => {
  const f = fixture();
  try {
    const store = f.make(); await store.open(); await store.retain(row("callback-original"));
    const before = fs.readFileSync(f.file), saved = `${f.directory}.original`;
    f.setObserve(() => {
      fs.renameSync(f.directory, saved); fs.mkdirSync(f.directory, { mode: 0o700 }); fs.writeFileSync(f.file, before, { mode: 0o600 });
      return terminal("callback-original");
    });
    await rejected(store.ack(identity("callback-original")), "model_recovery_unavailable");
    assert.deepEqual(fs.readFileSync(path.join(saved, "identities.json")), before);
    assert.deepEqual(fs.readFileSync(f.file), before);
    await rejected(store.read(), "model_recovery_unavailable");
  } finally { await f.cleanup(); }
});

test("injected target substitution before atomic rename is fenced, preserving both the original and foreign files", async () => {
  const f = fixture(); const injected = injectFileSystem(); let armed = false;
  injected.linkSync = (source, destination) => {
    if (armed && source === f.file) {
      fs.renameSync(f.file, `${f.file}.original`);
      fs.writeFileSync(f.file, bytes(snapshot([row("foreign-target")])), { mode: 0o600 });
    }
    return fs.linkSync(source, destination);
  };
  try {
    const store = f.make({ fs: injected }); await store.open(); await store.retain(row("pinned-original"));
    const before = fs.readFileSync(f.file); armed = true;
    await rejected(store.retain(row("must-not-replace")), "model_recovery_commit_unknown");
    assert.deepEqual(fs.readFileSync(`${f.file}.original`), before);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).operations[0].operationId, "foreign-target");
    await rejected(store.read(), "model_recovery_unavailable");
  } finally { await f.cleanup(); }
});

(async () => {
  const results = [];
  for (const entry of tests) {
    try { await entry.run(); results.push({ name: entry.name, pass: true }); process.stdout.write(`PASS ${entry.name}\n`); }
    catch (error) { results.push({ name: entry.name, pass: false, code: error?.code || "test_failed", message: String(error?.message || "Test failed") }); process.stderr.write(`FAIL ${entry.name}\n${error.stack}\n`); }
  }
  const report = { version: 1, total: results.length, passed: results.filter(value => value.pass).length, results,
    scope: "isolated temporary metadata files and actual durable journal only; zero App/Host/backend/network/token effects" };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.passed === report.total ? 0 : 1;
})();
