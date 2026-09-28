"use strict";

// Use the real native MemoryEngine on isolated synthetic stores. Never read
// the installed App or its profiles, and never substitute a toy lexical ranker.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");

const file = path.join(__dirname, "fixtures/shoggoth-memory-p4-multilingual-v1.json");
const bytes = fs.readFileSync(file);
assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),
  "e6a87b1e78a62e2ec3702b7860d3cd4985818db7f731e7b25b03615918516d39");
const data = JSON.parse(bytes);
assert.equal(data.records.length, 216);
assert.equal(data.queries.length, 216);
const found = {};
const visibleCounts = {};
for (const language of ["zh", "en", "mixed"]) {
  const fixture = memoryFixture({ now: 1_000 });
  try {
    for (const [position, record] of data.records.entries()) {
      const content = record[language === "mixed" ? (position % 2 === 0 ? "zh" : "en") : language];
      const saved = fixture.engine.propose({
        id: record.id, profileId: "profile-1", scope: "user", type: "semantic",
        content, sourceRefs: [`synthetic-${language}-${record.id}`], classification: "explicit",
      });
      assert.equal(saved.id, record.id);
      assert.equal(saved.status, "active");
      assert.equal(saved.sensitivity, "normal");
    }
    visibleCounts[language] = data.records.length;
    for (const sample of data.queries.filter((item) => item.corpusLanguage === language)) {
      found[sample.id] = fixture.engine.search({
        profileId: "profile-1", query: sample.query, scopes: ["user"],
        maxSensitivity: "normal", limit: 5, maxBytes: 16 * 1024, now: 10_000,
      }).items.map((item) => item.id);
    }
  } finally { fixture.cleanup(); }
}
assert.equal(Object.keys(found).length, data.queries.length);
process.stdout.write(`${JSON.stringify({ kind: "real-MemoryEngine-isolated-synthetic-control", visibleCounts, found })}\n`);
