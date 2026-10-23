"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { withMemoryHost } = require("../app/agent-service/shoggoth-memory/host-bridge.cjs");
const { MemorySourceFiles } = require("../app/agent-service/shoggoth-memory/source-files.cjs");

// Small synthetic containers only. No Service database, credentials, network,
// user media or shared sqlite fixture link is needed for source authority.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z5kAAAAASUVORK5CYII=", "base64");
const wav = Buffer.alloc(44);
wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34); wav.write("data", 36);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function fixture(t, { multimodal = { enabled: true, modalities: ["image", "audio"] }, workspaceBelowState = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-source-files-"));
  fs.chmodSync(root, 0o700);
  const workspace = workspaceBelowState ? path.join(root, "state", "agents", "one", "memory-workspace")
    : path.join(root, "one"), library = path.join(root, "library");
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"),
    profileDir: path.join(root, "profiles"), cacheDir: path.join(root, "cache"), runtimeDir: path.join(root, "runtime") };
  const roster = [{ id: "one", workspace }, { id: "two", workspace: path.join(root, "two") }];
  for (const directory of [path.join(workspace, "memory"), library, ...Object.values(paths), roster[1].workspace]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const config = { memory: { search: { provider: "none", extraPaths: [library], multimodal } } };
  let current = true;
  const host = {
    profileId: "one", workspaceDir: workspace, paths, roster: () => roster,
    assertCurrent() {
      if (!current || !roster.some(profile => profile.id === this.profileId && profile.workspace === this.workspaceDir)) {
        throw Object.assign(new Error("Fixture Profile revoked"), { code: "MEMORY_SCOPE_REVOKED" });
      }
    },
    assertWorkspace(target) {
      this.assertCurrent();
      assert.equal(target, workspace);
      if (fs.realpathSync.native(workspace) !== workspace) throw Object.assign(new Error("Fixture workspace redirected"), { code: "MEMORY_SCOPE_REVOKED" });
    },
    assertSecretOwnerAvailable(kind, owner) { assert.equal(kind, "capability"); assert.equal(owner, "memory-provider:one"); },
    resolveAgentConfig(cfg, id) { this.assertCurrent(); assert.equal(id, "one"); return cfg.agents?.entries?.[id] || {}; },
    run(action) { return withMemoryHost(this, action); },
  };
  const source = new MemorySourceFiles(host, () => config);
  const f = { root, workspace, library, host, config, source,
    write(name, data = png) {
      const target = path.join(library, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, data, { mode: 0o600 }); return target;
    },
    relative: target => source.relative(target), revoke: () => { current = false; },
    list: () => source.list(source.settings()),
    inspect: target => source.readForIndexing(source.relative(target)),
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return f;
}

test("native extraPaths discover image/audio while canonical memory stays Markdown-only", async t => {
  const f = fixture(t), image = f.write("diagram.PNG"), audio = f.write("meeting.wav", wav), note = f.write("guide.md", "Amber telescope");
  fs.writeFileSync(path.join(f.workspace, "MEMORY.md"), "Canonical memory", { mode: 0o600 });
  fs.writeFileSync(path.join(f.workspace, "memory", "default.png"), png, { mode: 0o600 });
  f.write("ignored.mp4", "fixture");
  assert.deepEqual((await f.list()).sort(), [image, audio, note, path.join(f.workspace, "MEMORY.md")].sort());
  assert.equal(f.source.isManaged("memory/default.png"), false);
  await assert.rejects(f.source.readForIndexing("memory/default.png"), { code: "MEMORY_PATH_NOT_ALLOWED" });
  f.config.memory.search.extraPaths.push(path.join(f.workspace, "memory"));
  assert.ok((await f.list()).includes(path.join(f.workspace, "memory", "default.png")), "an explicit extraPath may select media below memory/");
});

test("native glob and modality selection restrict discovery", async t => {
  const f = fixture(t, { multimodal: { enabled: true, modalities: ["image"] } });
  const chosen = f.write("visible/diagram.png"); f.write("hidden/diagram.png"); f.write("visible/meeting.wav", wav);
  f.config.memory.search.extraPaths = [{ path: f.library, pattern: "visible/**/*.png" }];
  assert.deepEqual(await f.list(), [chosen]);
  f.config.memory.search.multimodal.enabled = false;
  assert.deepEqual(await f.list(), []);
  await assert.rejects(f.inspect(chosen), { code: "MEMORY_PATH_NOT_ALLOWED" });
});

test("an explicit media file is an allowed extraPath without widening to its siblings", async t => {
  const f = fixture(t), image = f.write("diagram.png"), sibling = f.write("other.png");
  f.config.memory.search.extraPaths = [image];
  assert.deepEqual(await f.list(), [image]);
  assert.ok(await f.inspect(image));
  await assert.rejects(f.inspect(sibling), { code: "MEMORY_PATH_NOT_ALLOWED" });
});

test("native Profile multimodal overrides supplement global extraPaths", async t => {
  const f = fixture(t, { multimodal: { enabled: false } }), image = f.write("diagram.png"), audio = f.write("meeting.wav", wav);
  f.config.agents = { entries: { one: { memory: { search: { multimodal: { enabled: true, modalities: ["audio"] } } } } } };
  assert.deepEqual(await f.list(), [audio]);
  await assert.rejects(f.inspect(image), { code: "MEMORY_PATH_NOT_ALLOWED" });
});

test("private media snapshots and chunks equal the pinned original file algorithms", async t => {
  const f = fixture(t);
  for (const [name, bytes] of [["diagram.png", png], ["meeting.wav", wav]]) {
    const target = f.write(name, bytes), snapshot = await f.inspect(target);
    const native = await f.host.run(() => core.buildFileEntry(target, f.workspace, f.source.settings().multimodal));
    for (const key of Object.keys(native)) assert.deepEqual(snapshot[key], native[key], key);
    assert.equal(snapshot.sourceKind, "extra"); assert.equal(snapshot.text, native.contentText);
    assert.equal(snapshot.dataHash, digest(bytes));
    assert.equal(snapshot.byteIdentity.ino, fs.lstatSync(target).ino);
    assert.equal(Object.values(snapshot).some(value => Buffer.isBuffer(value)), false, "discovery cannot retain file bytes");
    assert.equal(JSON.stringify(snapshot).includes(bytes.toString("base64")), false, "discovery cannot retain base64 payloads");
    const built = await f.source.buildMultimodalChunk(snapshot), expected = await core.buildMultimodalChunkForIndexing(native);
    assert.deepEqual(built.chunk, expected.chunk); assert.equal(built.structuredInputBytes, expected.structuredInputBytes);
    assert.equal(built.canonicalRelativePath, snapshot.path);
    assert.equal(built.chunk.embeddingInput.parts[1].data, bytes.toString("base64"));
  }
});

test("getFile and maintenance source reads remain Markdown-only", async t => {
  const f = fixture(t), target = f.write("diagram.png"), note = f.write("guide.md", "# Amber\nTelescope");
  await f.inspect(target);
  assert.throws(() => f.source.read(f.relative(target)), { code: "MEMORY_PATH_NOT_ALLOWED" });
  assert.equal(f.source.read(f.relative(note)).text, "# Amber\nTelescope");
  const snapshot = await f.inspect(note);
  assert.equal(snapshot.kind, "extra"); assert.equal(snapshot.hash, core.hashText(snapshot.text));
  assert.equal(await f.source.buildMultimodalChunk(snapshot), null);
});

test("native maxFileBytes and MIME family reject media without binary text fallback", async t => {
  const f = fixture(t), target = f.write("diagram.png"), mismatched = f.write("audio-disguised.png", wav);
  f.config.memory.search.multimodal.maxFileBytes = png.length - 1;
  assert.equal(await f.inspect(target), null);
  f.config.memory.search.multimodal.maxFileBytes = png.length;
  assert.ok(await f.inspect(target));
  assert.equal(await f.inspect(mismatched), null);
  assert.throws(() => f.source.read(f.relative(mismatched)), { code: "MEMORY_PATH_NOT_ALLOWED" });
});

test("native media cap defaults to 10 MiB", async t => {
  const f = fixture(t), target = f.write("too-large.png");
  const fd = fs.openSync(target, "r+"); try { fs.ftruncateSync(fd, 10 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  assert.equal(f.source.settings().multimodal.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(await f.inspect(target), null);
});

test("media reads reject symbolic roots/leaves/parents, hardlinks and writable sources", async t => {
  const f = fixture(t), target = f.write("diagram.png"), alias = path.join(f.root, "alias");
  fs.symlinkSync(f.library, alias); f.config.memory.search.extraPaths.push(alias);
  await assert.rejects(f.inspect(path.join(alias, "diagram.png")), { code: "MEMORY_PATH_NOT_ALLOWED" });
  const leaf = path.join(f.library, "linked.png"); fs.symlinkSync(target, leaf);
  await assert.rejects(f.inspect(leaf), { code: "MEMORY_PATH_NOT_ALLOWED" });
  const parent = path.join(f.library, "linked-dir"); fs.symlinkSync(f.library, parent);
  await assert.rejects(f.inspect(path.join(parent, "diagram.png")), { code: "MEMORY_PATH_NOT_ALLOWED" });
  const hardlink = path.join(f.library, "hard.png"); fs.linkSync(target, hardlink);
  await assert.rejects(f.inspect(hardlink), { code: "MEMORY_PATH_NOT_ALLOWED" }); fs.unlinkSync(hardlink);
  fs.chmodSync(target, 0o666);
  await assert.rejects(f.inspect(target), { code: "MEMORY_PATH_NOT_ALLOWED" });
  fs.chmodSync(target, 0o600); fs.chmodSync(f.library, 0o777);
  await assert.rejects(f.inspect(target), { code: "MEMORY_PATH_NOT_ALLOWED" });
});

test("configured media cannot read another Profile or private Service directories", async t => {
  const f = fixture(t);
  for (const directory of [f.host.roster()[1].workspace, f.host.paths.stateDir, f.host.paths.profileDir, f.host.paths.cacheDir, f.host.paths.runtimeDir]) {
    const target = path.join(directory, "diagram.png"); fs.writeFileSync(target, png, { mode: 0o600 });
    f.config.memory.search.extraPaths.push(directory);
    await assert.rejects(f.inspect(target), { code: "MEMORY_PATH_NOT_ALLOWED" });
    assert.equal((await f.list()).includes(target), false);
  }
});

for (const directory of ["workspace", "memory", "nested"]) {
  test(`canonical Markdown rejects a writable ${directory} source parent`, async t => {
    const f = fixture(t), parent = directory === "workspace" ? f.workspace
      : path.join(f.workspace, "memory", ...(directory === "nested" ? ["notes"] : []));
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const target = path.join(parent, directory === "workspace" ? "MEMORY.md" : "topic.md");
    fs.writeFileSync(target, "Owned leaf below a writable parent", { mode: 0o600 });
    const relative = f.relative(target), snapshot = await f.inspect(target);
    assert.equal(f.source.read(relative).text, "Owned leaf below a writable parent");
    fs.chmodSync(parent, 0o770);
    assert.equal(f.source.snapshotCurrent(snapshot), false);
    assert.equal(f.source.classify(relative), null);
    assert.throws(() => f.source.read(relative), { code: "MEMORY_PATH_NOT_ALLOWED" });
    await assert.rejects(f.inspect(target), { code: "MEMORY_PATH_NOT_ALLOWED" });
    assert.equal((await f.list()).includes(target), false);
  });
}

test("explicit extra files require their directly authorized parent directory", async t => {
  const f = fixture(t), target = f.write("diagram.png"), note = f.write("guide.md", "Amber telescope");
  f.config.memory.search.extraPaths = [target, note];
  const snapshot = await f.inspect(target);
  assert.ok(snapshot); assert.equal(f.source.read(f.relative(note)).text, "Amber telescope");
  fs.chmodSync(f.library, 0o770);
  assert.equal(f.source.snapshotCurrent(snapshot), false);
  await assert.rejects(f.inspect(target), { code: "MEMORY_PATH_NOT_ALLOWED" });
  assert.throws(() => f.source.read(f.relative(note)), { code: "MEMORY_PATH_NOT_ALLOWED" });
  assert.deepEqual(await f.list(), []);
});

test("an explicitly owned library does not grant or require authority over its shared ancestor", async t => {
  const f = fixture(t), target = f.write("diagram.png");
  fs.chmodSync(f.root, 0o777);
  assert.ok(await f.inspect(target), "the configured owned directory is the source authority root");
  f.config.memory.search.extraPaths = [target];
  assert.ok(await f.inspect(target), "the explicit file's owned direct parent is its authority root");
});

test("private Service and foreign Profile roots nested in the workspace stay protected", async t => {
  const f = fixture(t);
  for (const key of ["stateDir", "profileDir", "cacheDir", "runtimeDir", "foreignProfile"]) {
    const directory = path.join(f.workspace, "memory", key);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const media = path.join(directory, "diagram.png"), note = path.join(directory, "topic.md");
    fs.writeFileSync(media, png, { mode: 0o600 }); fs.writeFileSync(note, "Private fixture", { mode: 0o600 });
    if (key === "foreignProfile") f.host.roster()[1].workspace = directory;
    else f.host.paths[key] = directory;
    f.config.memory.search.extraPaths.push(directory);
    for (const target of [media, note]) {
      assert.equal(f.source.classify(f.relative(target)), null);
      await assert.rejects(f.inspect(target), { code: "MEMORY_PATH_NOT_ALLOWED" });
      assert.equal((await f.list()).includes(target), false);
    }
    assert.throws(() => f.source.read(f.relative(note)), { code: "MEMORY_PATH_NOT_ALLOWED" });
  }
});

test("canonical memory below stateDir remains usable without exposing its Service siblings", async t => {
  const f = fixture(t, { workspaceBelowState: true }), note = path.join(f.workspace, "MEMORY.md"),
    media = path.join(f.workspace, "memory", "diagram.png"), privateFile = path.join(f.host.paths.stateDir, "secrets.png");
  fs.writeFileSync(note, "Canonical state-owned memory", { mode: 0o600 });
  fs.writeFileSync(media, png, { mode: 0o600 }); fs.writeFileSync(privateFile, png, { mode: 0o600 });
  f.config.memory.search.extraPaths.push(path.join(f.workspace, "memory"), f.host.paths.stateDir);
  assert.equal(f.source.read("MEMORY.md").text, "Canonical state-owned memory");
  assert.ok(await f.inspect(media));
  assert.ok((await f.list()).includes(note)); assert.ok((await f.list()).includes(media));
  assert.equal((await f.list()).includes(privateFile), false);
  await assert.rejects(f.inspect(privateFile), { code: "MEMORY_PATH_NOT_ALLOWED" });
});

test("media path transport rejects absolute, non-normalized and foreign path spellings", async t => {
  const f = fixture(t), target = f.write("diagram.png"), relative = f.relative(target);
  for (const value of [target, relative.replace("diagram.png", "./diagram.png"), relative.replaceAll("/", "\\"), `${relative}\0`]) {
    await assert.rejects(f.source.readForIndexing(value), { code: "MEMORY_PATH_NOT_ALLOWED" });
  }
});

test("same-sized byte changes invalidate source hashes and old prepared payloads", async t => {
  const f = fixture(t), target = f.write("diagram.png"), first = await f.inspect(target), replacement = Buffer.from(png);
  replacement[replacement.length - 1] ^= 1; fs.writeFileSync(target, replacement);
  const second = await f.inspect(target);
  assert.notEqual(second.dataHash, first.dataHash); assert.notEqual(second.hash, first.hash);
  assert.equal(f.source.snapshotCurrent(first), false); assert.equal(f.source.snapshotCurrent(second), true);
  assert.equal(await f.source.buildMultimodalChunk(first), null);
  assert.equal((await f.source.buildMultimodalChunk(second)).chunk.embeddingInput.parts[1].data, replacement.toString("base64"));
});

test("same bytes at a new inode invalidate the old source authority", async t => {
  const f = fixture(t), target = f.write("diagram.png"), first = await f.inspect(target), replacement = f.write("replacement.png");
  fs.renameSync(replacement, target);
  const second = await f.inspect(target);
  assert.equal(second.hash, first.hash); assert.notEqual(second.authorityStamp, first.authorityStamp);
  assert.equal(f.source.snapshotCurrent(first), false); assert.equal(f.source.snapshotCurrent(second), true);
  assert.equal(await f.source.buildMultimodalChunk(first), null);
});

test("editing bytes during asynchronous MIME detection rejects the obsolete snapshot", async t => {
  const f = fixture(t), target = f.write("diagram.png"), pending = f.inspect(target), replacement = Buffer.from(png);
  replacement[replacement.length - 1] ^= 1; fs.writeFileSync(target, replacement);
  await assert.rejects(pending, { code: "MEMORY_SOURCE_CHANGED" });
});

test("media settings changes during MIME detection reject the obsolete snapshot", async t => {
  const f = fixture(t), target = f.write("diagram.png"), pending = f.inspect(target);
  f.config.memory.search.multimodal.modalities = ["audio"];
  await assert.rejects(pending, { code: "MEMORY_SOURCE_CHANGED" });
});

test("source discovery cannot finish against settings revoked while the directory scan yields", async t => {
  const f = fixture(t); f.write("diagram.png");
  const pending = f.list(); f.config.memory.search.extraPaths = [];
  await assert.rejects(pending, { code: "MEMORY_SOURCE_CHANGED" });
});

test("growing a source during fd reading cannot return obsolete or unbounded media", async t => {
  const f = fixture(t), target = f.write("diagram.png"), ino = fs.lstatSync(target).ino, original = fs.readSync;
  let mutated = false;
  const intercept = t.mock.method(fs, "readSync", (...args) => {
    const count = original(...args);
    if (!mutated && fs.fstatSync(args[0]).ino === ino) { mutated = true; fs.appendFileSync(target, Buffer.from([0])); }
    return count;
  });
  try { await assert.rejects(f.inspect(target), { code: "MEMORY_SOURCE_CHANGED" }); }
  finally { intercept.mock.restore(); }
  assert.equal(mutated, true);
});

test("revoking extraPaths during fd reading invalidates the source before it escapes", async t => {
  const f = fixture(t), target = f.write("diagram.png"), ino = fs.lstatSync(target).ino, original = fs.readSync;
  let revoked = false;
  const intercept = t.mock.method(fs, "readSync", (...args) => {
    const count = original(...args);
    if (!revoked && fs.fstatSync(args[0]).ino === ino) { revoked = true; f.config.memory.search.extraPaths = []; }
    return count;
  });
  try { await assert.rejects(f.inspect(target), { code: "MEMORY_SOURCE_CHANGED" }); }
  finally { intercept.mock.restore(); }
  assert.equal(revoked, true);
});

test("source disappearance follows the native null snapshot/chunk contract", async t => {
  const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target);
  fs.unlinkSync(target);
  assert.equal(f.source.snapshotCurrent(snapshot), false);
  assert.equal(await f.inspect(target), null);
  assert.equal(await f.source.buildMultimodalChunk(snapshot), null);
  const present = f.write("diagram.png"), pending = f.inspect(present); fs.unlinkSync(present);
  assert.equal(await pending, null);
});

test("forged retained fields cannot supply an inline payload for another source", async t => {
  const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target), other = f.write("other.png");
  assert.equal(await f.source.buildMultimodalChunk({ ...snapshot, path: f.relative(other), absPath: other }), null);
  assert.equal(await f.source.buildMultimodalChunk({ ...snapshot, dataHash: "0".repeat(64) }), null);
  const built = await f.source.buildMultimodalChunk({ ...snapshot, mimeType: "audio/wav", contentText: "FORGED" });
  assert.equal(built.chunk.text, snapshot.contentText);
  assert.equal(built.chunk.embeddingInput.parts[1].mimeType, "image/png");
});

for (const change of ["path", "modality", "cap", "sources", "disabled"]) {
  test(`retained settings cannot authorize media after ${change} revocation`, async t => {
    const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target), settings = f.source.settings();
    if (change === "path") f.config.memory.search.extraPaths = [];
    if (change === "modality") f.config.memory.search.multimodal.modalities = ["audio"];
    if (change === "cap") f.config.memory.search.multimodal.maxFileBytes = 1;
    if (change === "sources") f.config.memory.search.sources = ["sessions"];
    if (change === "disabled") f.config.memory.search.enabled = false;
    assert.equal(f.source.snapshotCurrent(snapshot), false);
    assert.equal(f.source.snapshotCurrent(snapshot, settings), false);
    await assert.rejects(f.source.readForIndexing(f.relative(target), settings), { code: "MEMORY_SOURCE_CHANGED" });
    await assert.rejects(f.source.buildMultimodalChunk(snapshot, settings), { code: "MEMORY_SOURCE_CHANGED" });
  });
}

test("Profile revocation rejects in-flight and retained media sources", async t => {
  const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target), pending = f.inspect(target);
  f.revoke();
  assert.throws(() => f.source.snapshotCurrent(snapshot), { code: "MEMORY_SCOPE_REVOKED" });
  await assert.rejects(pending, { code: "MEMORY_SCOPE_REVOKED" });
  await assert.rejects(f.source.buildMultimodalChunk(snapshot), { code: "MEMORY_SCOPE_REVOKED" });
});

test("a replaced workspace cannot continue indexing retained media", async t => {
  const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target);
  fs.renameSync(f.workspace, `${f.workspace}-retired`); fs.symlinkSync(`${f.workspace}-retired`, f.workspace);
  assert.throws(() => f.source.snapshotCurrent(snapshot), { code: "MEMORY_SCOPE_REVOKED" });
  await assert.rejects(f.source.buildMultimodalChunk(snapshot), { code: "MEMORY_SCOPE_REVOKED" });
});

test("snapshotCurrent synchronously revalidates Markdown and media without payloads or writes", async t => {
  const f = fixture(t), canonical = path.join(f.workspace, "MEMORY.md");
  fs.writeFileSync(canonical, "Canonical telescope", { mode: 0o600 });
  const targets = [canonical, f.write("guide.md", "Extra telescope"), f.write("diagram.png"), f.write("meeting.wav", wav)];
  const snapshots = await Promise.all(targets.map(target => f.inspect(target))), originals = snapshots.map(snapshot => JSON.stringify(snapshot));
  const intercept = t.mock.method(fs, "writeFileSync", () => { throw new Error("A synchronous validator must not write state"); });
  try {
    for (const [i, snapshot] of snapshots.entries()) {
      const result = f.source.snapshotCurrent(snapshot);
      assert.equal(typeof result, "boolean"); assert.equal(result, true);
      assert.equal(JSON.stringify(snapshot), originals[i]);
      assert.equal(Object.values(snapshot).some(value => Buffer.isBuffer(value)), false);
      assert.equal("embeddingInput" in snapshot, false);
    }
  } finally { intercept.mock.restore(); }
});

test("synchronous authority rejects altered identities and retained source fields", async t => {
  const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target), note = f.write("guide.md", "Amber telescope");
  for (const replacement of [
    { path: f.relative(note), absPath: note }, { absPath: note }, { sourceKind: "memory" }, { kind: "extra" },
    { modality: "audio" }, { mimeType: "image/jpeg" }, { hash: "0".repeat(64) }, { dataHash: "0".repeat(64) },
    { contentText: "FORGED" }, { text: "FORGED" }, { authorityStamp: "0".repeat(64) }, { size: snapshot.size + 1 },
    { mtimeMs: snapshot.mtimeMs + 1 }, { mode: 0o100666 }, { byteIdentity: { ...snapshot.byteIdentity, ino: -1 } },
  ]) assert.equal(f.source.snapshotCurrent({ ...snapshot, ...replacement }), false);
  for (const invalid of [null, undefined, {}, { path: snapshot.path, hash: snapshot.hash }]) assert.equal(f.source.snapshotCurrent(invalid), false);
  const textSnapshot = await f.inspect(note);
  assert.equal(f.source.snapshotCurrent({ ...textSnapshot, text: "FORGED" }), false);
  fs.writeFileSync(note, "Different text"); assert.equal(f.source.snapshotCurrent(textSnapshot), false);
});

test("synchronous authority rechecks parent permissions after its fd read", async t => {
  const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target), ino = snapshot.byteIdentity.ino, original = fs.readSync;
  let revoked = false;
  const intercept = t.mock.method(fs, "readSync", (...args) => {
    const count = original(...args);
    if (!revoked && fs.fstatSync(args[0]).ino === ino) { revoked = true; fs.chmodSync(f.library, 0o770); }
    return count;
  });
  try { assert.equal(f.source.snapshotCurrent(snapshot), false); }
  finally { intercept.mock.restore(); }
  assert.equal(revoked, true);
});

test("synchronous authority rechecks newly protected roots and Profile ownership", async t => {
  const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target), previous = f.host.paths.cacheDir;
  f.host.paths.cacheDir = f.library; assert.equal(f.source.snapshotCurrent(snapshot), false);
  f.host.paths.cacheDir = previous; assert.equal(f.source.snapshotCurrent(snapshot), true);
  f.host.roster()[1].workspace = f.library; assert.equal(f.source.snapshotCurrent(snapshot), false);
});

test("synchronous authority preserves genuine I/O failures for its owner", async t => {
  const f = fixture(t), target = f.write("diagram.png"), snapshot = await f.inspect(target);
  const intercept = t.mock.method(fs, "readSync", () => { throw Object.assign(new Error("Fixture storage I/O failed"), { code: "EIO" }); });
  try { assert.throws(() => f.source.snapshotCurrent(snapshot), { code: "EIO" }); }
  finally { intercept.mock.restore(); }
});
