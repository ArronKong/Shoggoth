"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { test } = require("node:test");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { NativeSemanticIndex } = require("../app/agent-service/native-semantic-index");
const { hashText } = require("../app/agent-service/e5-encoder");
const { openDatabase } = require("../app/agent-service/inspiration-database");
const { centerLanguageScores } = require("../app/agent-service/memory-semantic-ranking");
const vector = new Float32Array(384); vector[0] = 1;
const document = text => ({ id: hashText("doc"), contentHash: hashText(text), text,
  source: { sourceId: "source-1", workspace: null, language: "other", occurredAt: 1,
    scope: "user", sensitivity: 0, validFrom: 0, validUntil: null, workspaceRefs: [] } });
const stamp = hashText("stamp");
function populate(index, text = "A synthetic fact.", revision = stamp) {
  const { epoch } = index.begin("profile-1", "memory", revision), doc = document(text);
  index.write("profile-1", "memory", revision, epoch, doc, [{ start: 0, end: text.length, vector }]);
  return index.commit("profile-1", "memory", revision, epoch);
}
test("unchanged vectors are reused exactly and a model identity change rebuilds only derived data", () => {
  const f = memoryFixture(), index = new NativeSemanticIndex({ paths: f.paths, modelIdentity: hashText("model-1") });
  const file = path.join(f.paths.agentsDir, "profile-1", "native-memory-semantic.sqlite");
  try {
    assert.deepEqual(populate(index), { documents: 1, chunks: 1 });
    const db = openDatabase(file);
    const before = Buffer.from(db.prepare("SELECT vector FROM vectors").get().vector);
    assert.equal(index.reusable("profile-1", "memory", document("A synthetic fact.")), true);
    assert.equal(index.reusable("profile-1", "memory", document("Changed fact.")), false);
    const next = hashText("next"), { epoch } = index.begin("profile-1", "memory", next);
    index.write("profile-1", "memory", next, epoch, document("A synthetic fact."));
    index.commit("profile-1", "memory", next, epoch);
    assert.deepEqual(Buffer.from(db.prepare("SELECT vector FROM vectors").get().vector), before);
    db.close(); index.close();
    const upgrade = new NativeSemanticIndex({ paths: f.paths, modelIdentity: hashText("model-2") });
    try { assert.equal(upgrade.ready("profile-1", "memory", next), false); populate(upgrade); }
    finally { upgrade.close(); }
    assert.equal(f.store.getRevision("profile-1"), 0);
  } finally { index.close(); f.cleanup(); }
});
for (const damage of ["missing-vector", "missing-file", "replacement-file"]) test("derived cache detects " + damage, () => {
  const f = memoryFixture(), index = new NativeSemanticIndex({ paths: f.paths, modelIdentity: hashText("model") });
  const file = path.join(f.paths.agentsDir, "profile-1", "native-memory-semantic.sqlite");
  try {
    populate(index);
    assert.equal(index.search("profile-1", "memory", stamp, vector).results.length, 1);
    if (damage === "missing-vector") {
      const db = openDatabase(file); db.prepare("DELETE FROM vectors").run(); db.close();
    } else {
      fs.unlinkSync(file);
      if (damage === "replacement-file") fs.writeFileSync(file, "invalid", { mode: 0o600 });
    }
    assert.throws(() => index.search("profile-1", "memory", stamp, vector), { code: "E5_INDEX_CORRUPT" });
    index.invalidate("profile-1"); populate(index);
    assert.equal(index.search("profile-1", "memory", stamp, vector).results.length, 1);
  } finally { index.close(); f.cleanup(); }
});

test("bounded ranking preserves best chunks, language centering, ties and authorization before scoring", () => {
  const f = memoryFixture(), index = new NativeSemanticIndex({ paths: f.paths, modelIdentity: hashText("ranking-model") });
  const expected = [];
  try {
    const { epoch } = index.begin("profile-1", "memory", stamp);
    for (let i=0; i<48; i++) {
      const text = `Synthetic ranking document ${i}.`, cosine = .70 + (i%12)*.02;
      const source = { ...document(text).source, sourceId: `source-${i}`, language: i%2 ? "han" : "other",
        sensitivity: i%11 === 0 ? 1 : 0, validUntil: i%13 === 0 ? 10 : null };
      const doc = { ...document(text), id: hashText(`rank-${i}`), source };
      const high = new Float32Array(384); high[0]=cosine; high[1]=Math.sqrt(1-cosine*cosine);
      const low = new Float32Array(384); low[0]=.6; low[1]=.8;
      index.write("profile-1", "memory", stamp, epoch, doc,
        [{ start: 0, end: 12, vector: low }, { start: 8, end: text.length, vector: high }]);
      if (!source.sensitivity && source.validUntil === null) expected.push({ id: doc.id,
        contentHash: doc.contentHash, source, part: 1, start: 8, end: text.length, score: high[0] });
    }
    index.commit("profile-1", "memory", stamp, epoch);
    const compare = (a,b) => b.rankScore-a.rankScore || a.id.localeCompare(b.id);
    const all = centerLanguageScores(expected).sort(compare);
    for (const limit of [1,5,17,100]) assert.deepEqual(index.search("profile-1", "memory", stamp, vector,
      { now: 100, maxSensitivity: 0 }, limit).results, all.slice(0,limit));
  } finally { index.close(); f.cleanup(); }
});
