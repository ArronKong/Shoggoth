"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { MemoryProvenanceStore } = require("../app/agent-service/memory-provenance-store");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fixture = memoryFixture();
try {
  const sourceText = "请记住我更喜欢简洁回答";
  const quote = "喜欢简洁回答";
  const entry = {
    operationId: "save-1", profileId: "profile-1", memoryId: "memory-1", memoryRevision: 1,
    contentHash: hash("用户喜欢简洁回答"), origin: "conversation", runId: "run-1",
    sessionId: "session-1", eventId: "event-1", eventTextHash: hash(sourceText),
    quoteHash: hash(quote), quoteStartUtf16: sourceText.indexOf(quote),
    quoteEndUtf16: sourceText.indexOf(quote) + quote.length, observedAt: 1000,
  };
  const store = new MemoryProvenanceStore({ paths: fixture.paths });
  store.open();
  assert.deepEqual(store.append(entry), entry);
  assert.deepEqual(store.append({ ...entry, observedAt: 2000 }), entry, "同一操作重试幂等");
  assert.throws(() => store.append({ ...entry, eventId: "event-2" }), { code: "MEMORY_PROVENANCE_CONFLICT" });
  assert.deepEqual(store.findForItem("profile-1", { id: "memory-1", content: "用户喜欢简洁回答" }), entry);
  assert.equal(store.findForItem("profile-1", { id: "memory-1", content: "用户喜欢详细回答" }), null);
  const importEntry = {
    operationId: "import-1", profileId: "profile-1", memoryId: "import-memory-1",
    memoryRevision: 2, contentHash: hash("Imported fact"), origin: "import",
    runId: null, sessionId: null, eventId: null, eventTextHash: null,
    quoteHash: null, quoteStartUtf16: null, quoteEndUtf16: null,
    importFile: { name: "MEMORY.md", fileHash: hash("original file bytes"),
      sourceRef: `codex-memory:${"a".repeat(32)}` }, observedAt: 2000,
  };
  assert.deepEqual(store.append(importEntry), importEntry);
  assert.throws(() => store.append({ ...importEntry, operationId: "bad-path",
    importFile: { ...importEntry.importFile, name: "/private/secret.md" } }),
  { code: "MEMORY_PROVENANCE_INVALID" });
  const legacyImport = { ...entry, operationId: "legacy-import", memoryId: "old-import",
    origin: "import", runId: null, sessionId: null, eventId: null, eventTextHash: null,
    quoteHash: null, quoteStartUtf16: null, quoteEndUtf16: null };
  assert.deepEqual(store.append(legacyImport), legacyImport);
  const target = path.join(fixture.paths.agentsDir, "profile-1", "memory", "provenance.jsonl");
  assert.deepEqual(fs.readFileSync(target, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line).schemaVersion), [1, 2, 1],
  "新旧来源记录可以共存，不迁移旧版 journal");
  assert.equal(fs.readFileSync(target, "utf8").includes(sourceText), false, "旁表不复制原话");
  store.close();

  const reopened = new MemoryProvenanceStore({ paths: fixture.paths });
  reopened.open();
  assert.deepEqual(reopened.getByOperation("profile-1", "save-1"), entry);
  assert.deepEqual(reopened.getByOperation("profile-1", "import-1"), importEntry);
  assert.deepEqual(reopened.getByOperation("profile-1", "legacy-import"), legacyImport);
  reopened.close();
  fs.appendFileSync(target, '{"interrupted":');
  const repaired = new MemoryProvenanceStore({ paths: fixture.paths });
  repaired.open();
  assert.deepEqual(repaired.getByOperation("profile-1", "save-1"), entry);
  repaired.close();
  assert.equal(fs.readFileSync(target, "utf8").includes("interrupted"), false);

  const lines = fs.readFileSync(target, "utf8").split("\n");
  lines[0] = lines[0].replace("event-1", "event-9");
  fs.writeFileSync(target, lines.join("\n"));
  const corrupt = new MemoryProvenanceStore({ paths: fixture.paths });
  corrupt.open();
  assert.throws(() => corrupt.getByOperation("profile-1", "save-1"), {
    code: "MEMORY_PROVENANCE_CORRUPT",
  });
  corrupt.close();
} finally {
  fixture.cleanup();
}
console.log("shoggoth memory provenance unit: passed");
