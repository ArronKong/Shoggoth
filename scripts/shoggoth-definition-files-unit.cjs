"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentDefinitionStore, DOCUMENT_KINDS, manifestChecksum } = require("../app/agent-service/agent-definition-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { V3_DEFAULT_AGENTS, createDefaultDocuments } = require("../app/agent-service/agent-definition-defaults");
const { factWasPresent, normalizeRule } = require("../app/agent-service/agent-definition-provenance");
const digest = text => crypto.createHash("sha256").update(text).digest("hex");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-definition-files-")));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const id = "fixture", dir = path.join(paths.agentsDir, id);
  const store = options => new AgentDefinitionStore({ paths, ...options });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths, id, dir, store,
    backups: () => fs.readdirSync(path.join(dir, "definition", "backups")).sort(),
    save(s, documents) { return s.update({ profileId: id, expectedRevision: s.get(id).manifest.revision, documents, actor: "user" }); },
  };
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

function legacy(f, versions) {
  for (let index = 0; index < versions.length; index++) {
    const revision = index + 1, entry = versions[index];
    const documents = { ...createDefaultDocuments("Fixture"), ...entry.documents };
    const manifest = { schemaVersion: 1, profileId: f.id, revision,
      documents: Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, { kind,
        path: `definition/revisions/${revision}/${kind}.md`, contentHash: digest(documents[kind]),
        byteLength: Buffer.byteLength(documents[kind]), revision }])),
      actor: entry.actor || "user", reason: entry.reason || null, createdAt: 10, updatedAt: 10 + revision };
    manifest.checksum = manifestChecksum(manifest);
    for (const kind of DOCUMENT_KINDS) write(path.join(f.dir, manifest.documents[kind].path), documents[kind]);
    write(path.join(f.dir, "definition", "revisions", String(revision), "manifest.json"), JSON.stringify(manifest));
    write(path.join(f.dir, "manifest.json"), JSON.stringify(manifest));
  }
}

test("migrates exact legacy bytes into fixed Agent files and retains three complete backups", t => {
  const f = fixture(t), final = { IDENTITY: "\ufeff# 身份\r\n保留原样。\r\n", SOUL: "", AGENTS: "规则 😀\n", USER: "旧资料\n" };
  legacy(f, [...Array.from({ length: 6 }, (_, i) => ({ documents: { SOUL: `old-${i}` } })), { documents: final }]);
  write(path.join(f.dir, "definition/revisions/.DS_Store"), "Finder metadata");
  const memory = path.join(f.dir, "memory-workspace", "USER.md"), heartbeat = path.join(f.dir, "HEARTBEAT.md");
  write(memory, "当前用户记忆，与旧定义中的 USER 不同。\n"); write(heartbeat, "主动检查原文\n");
  const s = f.store(); s.open();
  assert.deepEqual(s.get(f.id).documents, final);
  for (const kind of ["IDENTITY", "SOUL", "AGENTS"]) {
    assert.equal(fs.readFileSync(path.join(f.dir, `${kind}.md`), "utf8"), final[kind]);
    assert.equal(s.documentDirectory(f.id, kind, 7), f.dir);
  }
  assert.equal(fs.readFileSync(memory, "utf8"), "当前用户记忆，与旧定义中的 USER 不同。\n");
  assert.equal(fs.readFileSync(heartbeat, "utf8"), "主动检查原文\n");
  assert.deepEqual(f.backups(), ["4", "5", "6"]);
  assert.deepEqual(s.history(f.id).map(m => m.revision), [7, 6, 5, 4]);
  assert.equal(s.readRevision(f.id, 3), null);
  assert.equal(s.readRevision(f.id, 6).documents.SOUL, "old-5");
  assert.equal(fs.existsSync(path.join(f.dir, "definition", "revisions")), false);
  s.close(); s.open();
  assert.deepEqual(s.get(f.id).documents, final);
  assert.deepEqual(f.backups(), ["4", "5", "6"]);
});

test("App saves, no-op saves, external editor replacement and restore keep one current set plus three backups", t => {
  const f = fixture(t), s = f.store(); s.open(); s.ensureProfile({ profileId: f.id });
  for (let i = 0; i < 6; i++) f.save(s, { SOUL: `App edit ${i}` });
  const before = s.get(f.id);
  assert.equal(f.save(s, { SOUL: before.documents.SOUL }).manifest.revision, before.manifest.revision);
  assert.deepEqual(f.backups(), ["4", "5", "6"]);
  const outside = path.join(f.dir, "editor.tmp");
  fs.writeFileSync(outside, "\ufeff外部编辑器的更新\r\n", { mode: 0o644 });
  fs.renameSync(outside, path.join(f.dir, "SOUL.md"));
  assert.throws(() => s.update({ profileId: f.id, expectedRevision: before.manifest.revision,
    actor: "user", documents: { SOUL: "stale draft" } }), { code: "DEFINITION_REVISION_CONFLICT" });
  const external = s.get(f.id);
  assert.equal(external.documents.SOUL, "\ufeff外部编辑器的更新\r\n");
  assert.equal(external.manifest.revision, before.manifest.revision + 1);
  assert.equal(s.readRevision(f.id, before.manifest.revision).documents.SOUL, "App edit 5");
  const restored = s.restore({ profileId: f.id, revision: before.manifest.revision, expectedRevision: external.manifest.revision });
  assert.equal(restored.documents.SOUL, "App edit 5");
  assert.equal(s.readRevision(f.id, external.manifest.revision).documents.SOUL, external.documents.SOUL);
  assert.equal(f.backups().length, 3);
  const unchanged = s.get(f.id); s.close(); s.open(); assert.deepEqual(s.get(f.id), unchanged);
});

for (const point of ["migration-ready", "revision-ready", "document-written:IDENTITY", "document-written:SOUL", "revision-installed", "manifest-committed"]) {
  test(`legacy migration resumes without loss after ${point}`, t => {
    const f = fixture(t);
    const versions = Array.from({ length: 5 }, (_, i) => ({ documents: { SOUL: `soul-${i}`, AGENTS: `rules-${i}`, USER: `user-${i}` } }));
    legacy(f, versions);
    const failing = f.store({ faultInjector: name => { if (name === point) throw new Error("simulated interruption"); } });
    assert.throws(() => failing.open(), /simulated interruption/);
    const recovered = f.store(); recovered.open();
    for (const [kind, text] of Object.entries(versions[4].documents)) assert.equal(recovered.get(f.id).documents[kind], text);
    assert.deepEqual(f.backups(), ["2", "3", "4"]);
    assert.equal(recovered.get(f.id).manifest.revision, 5);
    assert.equal(fs.existsSync(path.join(f.dir, "definition", "pending.json")), false);
  });
}

for (const point of ["document-written:IDENTITY", "document-written:SOUL", "document-written:AGENTS"]) {
  test(`a partial multi-file save rolls back the whole set after ${point}`, t => {
    const f = fixture(t), s = f.store(); s.open(); const original = s.ensureProfile({ profileId: f.id });
    s.faultInjector = name => { if (name === point) throw new Error("simulated interruption"); };
    assert.throws(() => f.save(s, { IDENTITY: "new identity", SOUL: "new soul", AGENTS: "new rules" }), /simulated interruption/);
    const recovered = f.store(); recovered.open();
    assert.deepEqual(recovered.get(f.id), original);
    for (const kind of ["IDENTITY", "SOUL", "AGENTS"]) assert.equal(fs.readFileSync(path.join(f.dir, `${kind}.md`), "utf8"), original.documents[kind]);
    assert.deepEqual(f.backups(), []);
  });
}

test("external bytes survive interrupted adoption and an unexpected concurrent edit is never overwritten during recovery", t => {
  const f = fixture(t), s = f.store(); s.open(); s.ensureProfile({ profileId: f.id });
  fs.writeFileSync(path.join(f.dir, "SOUL.md"), "external user edit");
  s.faultInjector = point => { if (point === "revision-ready") throw new Error("interrupted"); };
  assert.throws(() => s.get(f.id), /interrupted/);
  const recovered = f.store(); recovered.open();
  assert.equal(recovered.get(f.id).documents.SOUL, "external user edit");
  recovered.faultInjector = point => { if (point === "document-written:IDENTITY") throw new Error("interrupted"); };
  assert.throws(() => f.save(recovered, { IDENTITY: "pending", SOUL: "pending soul" }), /interrupted/);
  fs.writeFileSync(path.join(f.dir, "SOUL.md"), "a newer independent edit");
  assert.throws(() => f.store().open(), { code: "DEFINITION_RECOVERY_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(f.dir, "SOUL.md"), "utf8"), "a newer independent edit");
});

test("migration refuses a conflicting workspace file without modifying either source", t => {
  const f = fixture(t); legacy(f, [{ documents: { SOUL: "legacy" } }]);
  write(path.join(f.dir, "SOUL.md"), "independent file");
  const oldManifest = fs.readFileSync(path.join(f.dir, "manifest.json"));
  assert.throws(() => f.store().open(), { code: "DEFINITION_MIGRATION_CONFLICT" });
  assert.deepEqual(fs.readFileSync(path.join(f.dir, "manifest.json")), oldManifest);
  assert.equal(fs.readFileSync(path.join(f.dir, "definition/revisions/1/SOUL.md"), "utf8"), "legacy");
  assert.equal(fs.readFileSync(path.join(f.dir, "SOUL.md"), "utf8"), "independent file");
});

test("migration preserves unexpected files even inside an uncommitted legacy revision", t => {
  const f = fixture(t); legacy(f, [{ documents: { SOUL: "legacy" } }]);
  const extra = path.join(f.dir, "definition/revisions/2/personal-notes.md");
  write(extra, "preserve these notes");
  const original = fs.readFileSync(path.join(f.dir, "manifest.json"));
  assert.throws(() => f.store().open(), { code: "DEFINITION_MIGRATION_CONFLICT" });
  assert.deepEqual(fs.readFileSync(path.join(f.dir, "manifest.json")), original);
  assert.equal(fs.readFileSync(extra, "utf8"), "preserve these notes");
  assert.equal(fs.existsSync(path.join(f.dir, "SOUL.md")), false);
});

test("pruned user edits cannot make a restored default look untouched", t => {
  const f = fixture(t), s = f.store(); s.open();
  s._commit({ profileId: f.id, expectedRevision: 0, actor: "bootstrap", documents: { ...createDefaultDocuments("Fixture"), AGENTS: V3_DEFAULT_AGENTS } });
  f.save(s, { AGENTS: "a user customization" }); f.save(s, { AGENTS: V3_DEFAULT_AGENTS });
  for (let i = 0; i < 5; i++) f.save(s, { SOUL: `later ${i}` });
  assert.equal(s.readRevision(f.id, 2), null);
  assert.equal(s.ensureProfile({ profileId: f.id }).documents.AGENTS, V3_DEFAULT_AGENTS);
});

test("migration retains compact dialogue proofs after the corresponding file backups expire", t => {
  const f = fixture(t), fact = "杉湾项目的周报先列进展再列风险", oldFact = "既有项目的资料应逐字保留原文";
  legacy(f, [{ documents: { AGENTS: oldFact } },
    { documents: { AGENTS: `${oldFact}\n${fact}。${oldFact}。` }, reason: "conversation-definition:op-1" },
    ...Array.from({ length: 5 }, (_, i) => ({ documents: { AGENTS: `${oldFact}\n${fact}。${oldFact}。`, SOUL: String(i) } }))]);
  const s = f.store(); s.open(); assert.equal(s.readRevision(f.id, 2), null);
  const receipt = s.readReceipt(f.id, 2), line = `${fact}。${oldFact}。`;
  assert.equal(receipt.manifest.reason, "conversation-definition:op-1");
  const rule = receipt.rules.find(r => r.hash === digest(line));
  assert.equal(factWasPresent(line, normalizeRule(fact), rule.priorCoverage), false);
  assert.equal(factWasPresent(line, normalizeRule(oldFact), rule.priorCoverage), true);
  assert.equal(s.ruleProvenance(f.id)[digest(line)], 2);
  f.save(s, { AGENTS: oldFact }); f.save(s, { AGENTS: `${oldFact}\n${line}` });
  assert.notEqual(s.ruleProvenance(f.id)[digest(line)], 2);
});

test("external aliases and malformed UTF-8 never replace a valid saved definition", t => {
  const f = fixture(t), s = f.store(); s.open(); s.ensureProfile({ profileId: f.id });
  const soul = path.join(f.dir, "SOUL.md"), elsewhere = path.join(f.root, "elsewhere.md");
  write(elsewhere, "must stay unchanged"); fs.unlinkSync(soul); fs.symlinkSync(elsewhere, soul);
  assert.throws(() => s.get(f.id), { code: "UNSAFE_PATH" });
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "must stay unchanged");
  fs.unlinkSync(soul); fs.writeFileSync(soul, Buffer.from([0xff]), { mode: 0o600 });
  assert.throws(() => s.get(f.id), { code: "DEFINITION_DOCUMENT_INVALID" });
  assert.deepEqual(f.backups(), []);
});
