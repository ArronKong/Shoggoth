"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { openDatabase, transaction } = require("../app/agent-service/inspiration-database");
const FIXTURE = require("./fixtures/shoggoth-memory-evaluation-v1.json");

function arg(name, fallback) {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!match) return fallback;
  const number = Number(match.slice(name.length + 3));
  assert.ok(Number.isSafeInteger(number) && number >= 0);
  return number;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3));
}

function bigramTerms(text) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const segments = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) || [];
  const terms = [];
  for (const segment of segments) {
    if (!/\p{Script=Han}/u.test(segment)) terms.push(segment);
    else if ([...segment].length === 1) terms.push(segment);
    else {
      const chars = [...segment];
      for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1]);
    }
  }
  return [...new Set(terms)];
}

function scoredDocs() {
  const memory = FIXTURE.memoryItems.map((item) => ({
    id: item.id, collection: "A", text: item.content,
  }));
  const eligible = FIXTURE.conversation.sessions.filter((session) => (
    session.profileId === "profile-1" && session.workspace === "/synthetic/project-a"
    && ["ready", "archived"].includes(session.status)
    && (session.run.source === "chat" && !session.run.idempotencyKey
      || session.run.source === "inspiration" && session.run.inputSource === "chat")
  ));
  const conversation = eligible.flatMap((session) => session.events
    .filter((event) => ["user", "assistant"].includes(event.kind)
      && !event.contextExcluded && !event.revoked)
    .map((event) => ({ id: event.id, collection: "C", text: event.text })));
  return [...memory, ...conversation];
}

function createIndex(file, strategy, docs) {
  const db = openDatabase(file);
  const tokenizer = strategy === "trigram" ? "trigram" : "unicode61 tokenchars '-_'";
  db.exec(`CREATE TABLE raw_docs (doc_id TEXT PRIMARY KEY, collection TEXT NOT NULL, raw_text TEXT NOT NULL);
    CREATE VIRTUAL TABLE lexical USING fts5(doc_id UNINDEXED, collection UNINDEXED,
      search_text, tokenize="${tokenizer}");`);
  const rawInsert = db.prepare("INSERT INTO raw_docs(doc_id,collection,raw_text) VALUES(?,?,?)");
  const indexInsert = db.prepare("INSERT INTO lexical(doc_id,collection,search_text) VALUES(?,?,?)");
  transaction(db, () => {
    for (const doc of docs) {
      rawInsert.run(doc.id, doc.collection, doc.text);
      indexInsert.run(doc.id, doc.collection,
        strategy === "trigram" ? doc.text : bigramTerms(doc.text).join(" "));
    }
  });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return db;
}

function queryIndex(db, strategy, collection, query) {
  if (strategy === "trigram" && [...query].length < 3) {
    return db.prepare(`SELECT doc_id FROM raw_docs WHERE collection=?
      AND instr(lower(raw_text),lower(?))>0 ORDER BY rowid DESC LIMIT 5`)
      .all(collection, query).map((row) => row.doc_id);
  }
  const match = strategy === "trigram" ? `"${query.replaceAll('"', '""')}"`
    : bigramTerms(query).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
  if (!match) return [];
  return db.prepare(`SELECT doc_id FROM lexical WHERE lexical MATCH ? AND collection=?
    ORDER BY bm25(lexical), rowid DESC LIMIT 5`)
    .all(match, collection).map((row) => row.doc_id);
}

function evaluate(db, strategy, samples, iterations) {
  const rows = [];
  const times = [];
  for (const sample of samples) {
    const found = queryIndex(db, strategy, sample.id[0], sample.query);
    const hits = sample.relevant.filter((id) => found.includes(id));
    rows.push({ id: sample.id, found, hits });
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      queryIndex(db, strategy, sample.id[0], sample.query);
      times.push(performance.now() - start);
    }
  }
  return {
    queries: samples.length,
    recallAt5: Number((rows.reduce((sum, row) => sum + row.hits.length, 0)
      / samples.reduce((sum, sample) => sum + sample.relevant.length, 0)).toFixed(4)),
    missed: rows.filter((row) => row.hits.length === 0).map((row) => row.id),
    queryMs: { p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: percentile(times, 1) },
  };
}

function main() {
  const noise = arg("noise", 10_000);
  const iterations = arg("iterations", 8);
  assert.ok(iterations > 0 && noise <= 100_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-tokenizer-"));
  fs.chmodSync(root, 0o700);
  const docs = scoredDocs();
  for (let i = 0; i < noise; i++) docs.push({
    id: `filler-${i}`, collection: "C",
    text: `合成会话记录 ${i}，流程标签 FX-${i}，状态是待检查。`,
  });
  const samples = [...FIXTURE.memoryQueries.A,
    ...FIXTURE.conversation.queries.filter((sample) => sample.relevant.length > 0)];
  const output = { fixtureVersion: FIXTURE.version, noiseMessages: noise, indexedDocs: docs.length,
    node: process.version, arch: process.arch, strategies: {} };
  try {
    for (const strategy of ["trigram", "bigram-unicode61"]) {
      const file = path.join(root, `${strategy}.sqlite`);
      const start = performance.now();
      const db = createIndex(file, strategy, docs);
      const buildMs = Number((performance.now() - start).toFixed(3));
      try {
        output.strategies[strategy] = {
          buildMs,
          indexMiB: Number((fs.statSync(file).size / 1_048_576).toFixed(3)),
          A: evaluate(db, strategy, FIXTURE.memoryQueries.A, iterations),
          C: evaluate(db, strategy,
            FIXTURE.conversation.queries.filter((sample) => sample.relevant.length > 0), iterations),
        };
      } finally { db.close(); }
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main();
