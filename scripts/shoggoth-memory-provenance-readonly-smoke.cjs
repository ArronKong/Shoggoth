"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const { MemoryProvenanceStore } = require("../app/agent-service/memory-provenance-store.js");
const FIXTURE_PARENT = fs.realpathSync.native(os.tmpdir());
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);
function capture(root) { const rows = []; const visit = file => { const stat = fs.lstatSync(file); const row = { file: path.relative(root, file), dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  if (stat.isSymbolicLink()) row.link = fs.readlinkSync(file); else if (stat.isDirectory()) { row.entries = fs.readdirSync(file).sort(); rows.push(row); for (const name of row.entries) visit(path.join(file, name)); return; } else row.sha256 = hash(fs.readFileSync(file)); rows.push(row); }; visit(root); return rows; }
function entry(extra = {}) { return { operationId: "operation-1", profileId: "profile-1", memoryId: "memory-1", memoryRevision: 1,
  contentHash: hash("合成偏好"), origin: "ui_create", runId: null, sessionId: null, eventId: null, eventTextHash: null,
  quoteHash: null, quoteStartUtf16: null, quoteEndUtf16: null, observedAt: 100, ...extra }; }
function fixture(t, { empty = false } = {}) { const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, "shoggoth-provenance-ro-")); fs.chmodSync(root, 0o700); const agentsDir = path.join(root, "agents");
  if (!empty) fs.mkdirSync(path.join(agentsDir, "profile-1", "memory"), { recursive: true, mode: 0o700 });
  const f = { root, paths: { trustedRoot: root, agentsDir }, target: path.join(agentsDir, "profile-1", "memory", "provenance.jsonl") };
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return f; }
function seed(f, entries = [entry()]) { const writable = new MemoryProvenanceStore({ paths: f.paths }); writable.open(); try { for (const row of entries) writable.append(row); } finally { writable.close(); } }
function guardFs() { const calls = []; const guarded = Object.create(fs);
  for (const name of ["mkdirSync", "chmodSync", "fchmodSync", "writeFileSync", "appendFileSync", "writeSync", "ftruncateSync", "truncateSync", "renameSync", "unlinkSync", "rmSync", "linkSync", "symlinkSync", "fsyncSync"]) guarded[name] = () => { calls.push(name); throw new Error(`readonly attempted ${name}`); };
  guarded.openSync = (file, flags, ...rest) => { if (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) { calls.push("openSync(write)"); throw new Error("readonly attempted writable open"); } return fs.openSync(file, flags, ...rest); };
  return { fs: guarded, calls }; }
function read(f, action, expected) { const guard = guardFs(), store = new MemoryProvenanceStore({ paths: f.paths, readOnly: true, fs: guard.fs }); const before = capture(f.root);
  try { if (expected) assert.throws(() => { store.open(); action(store); }, { code: expected }); else { store.open(); action(store); } }
  finally { store.close(); assert.deepEqual(guard.calls, []); assert.deepEqual(capture(f.root), before); } }

test("actual writable v1/v2/v3 rows are read unchanged with zero writes and cloned results", t => { const f = fixture(t), rows = [entry(), entry({ operationId: "import-v2", memoryId: "memory-2", memoryRevision: 2, origin: "import",
  importFile: { name: "MEMORY.md", fileHash: hash("原文件"), sourceRef: `codex-memory:${"a".repeat(32)}` } }), entry({ operationId: "import-v3", memoryId: "memory-3", memoryRevision: 3, origin: "import",
  importFile: { name: "资料.md", fileHash: hash("完整资料"), sourceRef: `codex-memory:${"b".repeat(32)}`, lineStart: 2, lineEnd: 4, excerptHash: hash("精确片段") } })]; seed(f, rows);
  assert.deepEqual(fs.readFileSync(f.target, "utf8").trimEnd().split("\n").map(s => JSON.parse(s).schemaVersion), [1, 2, 3]);
  read(f, store => { for (const row of rows) assert.deepEqual(store.getByOperation("profile-1", row.operationId), row);
    const result = store.getByOperation("profile-1", "operation-1"); result.memoryId = "mutated-return"; assert.deepEqual(store.findForItem("profile-1", { id: "memory-1", content: "合成偏好" }, 1), rows[0]);
    assert.equal(store.findForItem("profile-1", { id: "memory-1", content: "合成偏好" }, 2), null); }); });

test("conversation range/event hashes use original schema and exact payload", t => { const f = fixture(t), row = entry({ origin: "conversation", runId: "run-1", sessionId: "session-1", eventId: "event-1", eventTextHash: hash("原始合成用户话语"), quoteHash: hash("合成"), quoteStartUtf16: 2, quoteEndUtf16: 4 }); seed(f, [row]); read(f, store => assert.deepEqual(store.getByOperation("profile-1", row.operationId), row)); });

test("readOnly append refuses before any source read or write", t => { const f = fixture(t); seed(f); read(f, store => assert.throws(() => store.append(entry({ operationId: "new" })), { code: "MEMORY_LEGACY_READ_ONLY" })); });

test("missing agents/profile/log remain absent and are not mkdir/chmod", t => { const f = fixture(t, { empty: true }); read(f, store => assert.equal(store.getByOperation("profile-1", "absent"), null)); assert.equal(fs.existsSync(f.paths.agentsDir), false); });

for (const tail of ['{"foreign":', '{"complete":"JSON but no newline"}']) test(`unclosed owned-path tail rejects without truncate or quarantine ${tail}`, t => { const f = fixture(t); seed(f); fs.appendFileSync(f.target, tail); read(f, store => store.getByOperation("profile-1", "operation-1"), "MEMORY_PROVENANCE_TRANSACTION_UNSETTLED"); });

test("unclosed only row remains all bytes intact", t => { const f = fixture(t); fs.writeFileSync(f.target, '{"foreign-operation":', { mode: 0o600 }); read(f, store => store.getByOperation("profile-1", "operation-1"), "MEMORY_PROVENANCE_TRANSACTION_UNSETTLED"); });

test("checksum mismatch rejects without repairing source", t => { const f = fixture(t); seed(f); fs.writeFileSync(f.target, fs.readFileSync(f.target, "utf8").replace("memory-1", "memory-9")); read(f, store => store.getByOperation("profile-1", "operation-1"), "MEMORY_PROVENANCE_CORRUPT"); });

test("unknown payload field remains unrepresentable despite genuine recomputed checksum", t => { const f = fixture(t); seed(f); const row = JSON.parse(fs.readFileSync(f.target)); row.payload.authorityText = "完整原生 entry"; delete row.checksum; row.checksum = hash(stable(row)); fs.writeFileSync(f.target, `${stable(row)}\n`); read(f, store => store.getByOperation("profile-1", "operation-1"), "MEMORY_PROVENANCE_CORRUPT"); });

test("promotion cannot be relabeled as an original provenance origin", t => { const f = fixture(t); seed(f); const row = JSON.parse(fs.readFileSync(f.target)); row.payload.origin = "promotion"; delete row.checksum; row.checksum = hash(stable(row)); fs.writeFileSync(f.target, `${stable(row)}\n`); read(f, store => store.getByOperation("profile-1", "operation-1"), "MEMORY_PROVENANCE_CORRUPT"); });

test("sequence gap rejects original row protocol", t => { const f = fixture(t); seed(f); const row = JSON.parse(fs.readFileSync(f.target)); row.seq = 7; delete row.checksum; row.checksum = hash(stable(row)); fs.writeFileSync(f.target, `${stable(row)}\n`); read(f, store => store.getByOperation("profile-1", "operation-1"), "MEMORY_PROVENANCE_CORRUPT"); });

test("final log symlink remains untouched", t => { const f = fixture(t); seed(f); const owned = `${f.target}.fixture-source`; fs.renameSync(f.target, owned); fs.symlinkSync(owned, f.target); read(f, store => store.getByOperation("profile-1", "operation-1"), "UNSAFE_SYMLINK"); });

test("parent directory symlink is refused before file access", t => { const f = fixture(t); seed(f); const dir = path.dirname(f.target), retained = `${dir}-fixture-retained`; fs.renameSync(dir, retained); fs.symlinkSync(retained, dir); read(f, store => store.getByOperation("profile-1", "operation-1"), "UNSAFE_SYMLINK"); });

test("weak directory mode is rejected and never tightened", t => { const f = fixture(t); seed(f); fs.chmodSync(path.dirname(f.target), 0o755); read(f, store => store.getByOperation("profile-1", "operation-1"), "UNSAFE_PERMISSIONS"); });

test("hardlinked log is refused without unlink", t => { const f = fixture(t); seed(f); fs.linkSync(f.target, `${f.target}.fixture-link`); read(f, store => store.getByOperation("profile-1", "operation-1"), "UNSAFE_HARDLINK"); });

test("cached read rejects directory replacement even when actual journal inode is retained", t => { const f = fixture(t); seed(f); const guard = guardFs(), store = new MemoryProvenanceStore({ paths: f.paths, readOnly: true, fs: guard.fs }); store.open(); store.getByOperation("profile-1", "operation-1");
  const dir = path.dirname(f.target), retained = `${dir}-fixture-retained`; fs.renameSync(dir, retained); fs.mkdirSync(dir, { mode: 0o700 }); fs.renameSync(path.join(retained, "provenance.jsonl"), f.target);
  const before = capture(f.root); try { assert.throws(() => store.getByOperation("profile-1", "operation-1"), { code: "MEMORY_PROVENANCE_UNAVAILABLE" }); } finally { store.close(); assert.deepEqual(guard.calls, []); assert.deepEqual(capture(f.root), before); } });

test("missing parent appearing within one RO lifetime is not adopted", t => { const f = fixture(t, { empty: true }); const guard = guardFs(), store = new MemoryProvenanceStore({ paths: f.paths, readOnly: true, fs: guard.fs }); store.open(); store.getByOperation("profile-1", "missing"); fs.mkdirSync(path.dirname(f.target), { recursive: true, mode: 0o700 }); const before = capture(f.root);
  try { assert.throws(() => store.getByOperation("profile-1", "missing"), { code: "MEMORY_PROVENANCE_UNAVAILABLE" }); } finally { store.close(); assert.deepEqual(guard.calls, []); assert.deepEqual(capture(f.root), before); } });

test("directory replacement during genuine descriptor read cannot publish result", t => { const f = fixture(t); seed(f); const guard = guardFs(), inode = fs.statSync(f.target).ino; let changed = false;
  guard.fs.readFileSync = (...args) => { const value = fs.readFileSync(...args); if (!changed && typeof args[0] === "number") { changed = true; const dir = path.dirname(f.target), retained = `${dir}-fixture-retained`; fs.renameSync(dir, retained); fs.mkdirSync(dir, { mode: 0o700 }); fs.renameSync(path.join(retained, "provenance.jsonl"), f.target); } return value; };
  const store = new MemoryProvenanceStore({ paths: f.paths, readOnly: true, fs: guard.fs }); store.open(); try { assert.throws(() => store.getByOperation("profile-1", "operation-1"), { code: "MEMORY_PROVENANCE_UNAVAILABLE" }); assert.equal(changed, true); assert.equal(fs.statSync(f.target).ino, inode); } finally { store.close(); assert.deepEqual(guard.calls, []); } });

test("default writable mode preserves actual append idempotence and original tail repair", t => { const f = fixture(t); const row = entry(); seed(f); const store = new MemoryProvenanceStore({ paths: f.paths }); store.open(); assert.deepEqual(store.append({ ...row, observedAt: 200 }), row); store.close();
  fs.appendFileSync(f.target, '{"own-writer-interruption":'); const before = fs.statSync(f.target).size; const reopened = new MemoryProvenanceStore({ paths: f.paths }); reopened.open(); try { assert.deepEqual(reopened.getByOperation("profile-1", "operation-1"), row); assert.ok(fs.statSync(f.target).size < before); assert.equal(fs.readFileSync(f.target).at(-1), 10); } finally { reopened.close(); } });

function cachedAliasWindow(t, fixed) {
  const f = fixture(t); seed(f); const guard = guardFs();
  const dir = path.dirname(f.target), retained = `${dir}-cached-alias-retained`;
  let armed = false, changed = false, afterInjection;
  const nativeRealpath = fs.realpathSync.native;
  guard.fs.realpathSync = Object.assign((...args) => fs.realpathSync(...args), {
    native(directory, ...rest) {
      const canonical = nativeRealpath(directory, ...rest);
      if (armed && !changed && directory === dir) {
        changed = true; fs.renameSync(dir, retained); fs.symlinkSync(retained, dir);
        afterInjection = capture(f.root);
      }
      return canonical;
    },
  });
  const store = new MemoryProvenanceStore({ paths: f.paths, readOnly: true, fs: guard.fs });
  store.open(); assert.deepEqual(store.getByOperation("profile-1", "operation-1"), entry());
  const logBefore = fs.statSync(f.target); armed = true;
  try {
    if (fixed) assert.throws(() => store.getByOperation("profile-1", "operation-1"), { code: "UNSAFE_SYMLINK" });
    else assert.deepEqual(store.getByOperation("profile-1", "operation-1"), entry());
    assert.equal(changed, true); assert.ok(fs.lstatSync(dir).isSymbolicLink());
    const logAfter = fs.statSync(f.target);
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(logAfter[field], logBefore[field]);
    assert.deepEqual(guard.calls, []); assert.deepEqual(capture(f.root), afterInjection);
    console.log("CACHE_ALIAS_EVIDENCE " + JSON.stringify({ variant: fixed ? "fixed" : "old-v1",
      runtime: { electron: process.versions.electron || null, node: process.versions.node, arch: process.arch },
      cachedPrecheckCompletedBeforeAlias: true, actualLogIdentityUnchanged: true,
      result: fixed ? "UNSAFE_SYMLINK" : "cached-provenance-returned", storeMutationCalls: guard.calls.length,
      injectedAliasBytesAndIdentitiesPreserved: true }));
  } finally { store.close(); }
}

test("RO cached precheck alias window rejects before returning evidence and preserves the injected scene", t => cachedAliasWindow(t, true));

test("RO normal present and missing cached reads remain cloned and never mkdir/chmod/write", t => {
  const f = fixture(t); seed(f);
  read(f, store => {
    assert.deepEqual(store.getByOperation("profile-1", "operation-1"), entry());
    assert.deepEqual(store.getByOperation("profile-1", "operation-1"), entry());
    assert.equal(store.getByOperation("missing-profile", "absent"), null);
    assert.equal(store.getByOperation("missing-profile", "absent"), null);
    assert.equal(fs.existsSync(path.join(f.paths.agentsDir, "missing-profile")), false);
  });
});

test("RO fresh descriptor rejects an actual foreign parent ABA before reading or publishing evidence and physically closes the fd", t => {
  const f = fixture(t), original = entry({ memoryId: "memory-original" }), foreign = entry({ memoryId: "memory-foreign" }); seed(f, [original]);
  const foreignPaths = { ...f.paths, agentsDir: path.join(f.root, "foreign-agents") }, foreignDir = path.join(foreignPaths.agentsDir, "profile-1", "memory");
  seed({ paths: foreignPaths }, [foreign]);
  const dir = path.dirname(f.target), retained = `${dir}-fresh-fd-retained`, guard = guardFs();
  const namedBefore = fs.statSync(f.target), sourceBytes = fs.readFileSync(f.target), foreignStat = fs.statSync(path.join(foreignDir, "provenance.jsonl"));
  let swapped = false, restored = false, openedFd, openedStat, dataReads = 0, closed = 0, afterRestore;
  guard.fs.lstatSync = (file, ...rest) => {
    if (file === f.target && !swapped) { swapped = true; fs.renameSync(dir, retained); fs.symlinkSync(foreignDir, dir); }
    return fs.lstatSync(file, ...rest);
  };
  const safeOpen = guard.fs.openSync;
  guard.fs.openSync = (...args) => { openedFd = safeOpen(...args); openedStat = fs.fstatSync(openedFd); return openedFd; };
  guard.fs.readFileSync = (...args) => { if (typeof args[0] === "number") dataReads++; return fs.readFileSync(...args); };
  guard.fs.closeSync = fd => {
    fs.closeSync(fd); closed++;
    if (swapped && !restored) { fs.unlinkSync(dir); fs.renameSync(retained, dir); restored = true; afterRestore = capture(f.root); }
  };
  const reader = new MemoryProvenanceStore({ paths: f.paths, readOnly: true, fs: guard.fs }); reader.open();
  try {
    assert.throws(() => reader.getByOperation("profile-1", "operation-1"), { code: "MEMORY_PROVENANCE_UNAVAILABLE" });
    assert.equal(swapped, true); assert.equal(restored, true); assert.equal(openedStat.ino, foreignStat.ino); assert.notEqual(openedStat.ino, namedBefore.ino);
    assert.equal(dataReads, 0); assert.equal(closed, 1); assert.throws(() => fs.fstatSync(openedFd), { code: "EBADF" });
    const namedAfter = fs.statSync(f.target); for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(namedAfter[field], namedBefore[field]);
    assert.ok(fs.readFileSync(f.target).equals(sourceBytes)); assert.deepEqual(capture(f.root), afterRestore); assert.deepEqual(guard.calls, []);
    assert.equal(reader.profiles.has("profile-1"), false);
    console.log("FRESH_FD_FIXED_EVIDENCE " + JSON.stringify({ runtime: { electron: process.versions.electron || null, node: process.versions.node, arch: process.arch },
      originalNamedInode: namedBefore.ino, openedFdInode: openedStat.ino, foreignInode: foreignStat.ino, result: "MEMORY_PROVENANCE_UNAVAILABLE",
      actualDescriptorClosed: true, dataReads, returnedEvidence: false, originalNamedIdentityAndBytesPreserved: true, storeMutationCalls: guard.calls.length }));
  } finally { reader.close(); }
});

test("RO matching fresh fd remains readable and closes before present or missing cache reuse with zero writes", t => {
  const f = fixture(t); seed(f); const guard = guardFs(), before = capture(f.root), opened = [], descriptors = [], safeOpen = guard.fs.openSync;
  let closes = 0, descriptorChecks = 0;
  guard.fs.openSync = (...args) => { const fd = safeOpen(...args); opened.push(fd); descriptors.push(fs.fstatSync(fd)); return fd; };
  guard.fs.fstatSync = (...args) => { descriptorChecks++; return fs.fstatSync(...args); };
  guard.fs.closeSync = fd => { closes++; return fs.closeSync(fd); };
  const reader = new MemoryProvenanceStore({ paths: f.paths, readOnly: true, fs: guard.fs }); reader.open();
  try {
    assert.deepEqual(reader.getByOperation("profile-1", "operation-1"), entry()); assert.equal(opened.length, 1); assert.equal(closes, 1); assert.ok(descriptorChecks >= 2);
    assert.equal(descriptors[0].ino, fs.statSync(f.target).ino); assert.throws(() => fs.fstatSync(opened[0]), { code: "EBADF" });
    const cloned = reader.getByOperation("profile-1", "operation-1"); cloned.memoryId = "caller-mutated";
    assert.deepEqual(reader.getByOperation("profile-1", "operation-1"), entry());
    assert.equal(reader.getByOperation("missing-profile", "absent"), null); assert.equal(reader.getByOperation("missing-profile", "absent"), null);
    assert.equal(opened.length, 1); assert.equal(closes, 1); assert.equal(fs.existsSync(path.join(f.paths.agentsDir, "missing-profile")), false);
    assert.deepEqual(guard.calls, []); assert.deepEqual(capture(f.root), before);
  } finally { reader.close(); }
});
