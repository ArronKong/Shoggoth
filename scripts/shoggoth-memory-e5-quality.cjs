"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { E5Encoder, hashText } = require("../app/agent-service/e5-encoder");
const { SEMANTIC_MIN_COSINE, sourceLanguage, centerLanguageScores } = require("../app/agent-service/memory-semantic-ranking");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const output = path.resolve(__dirname, "../.artifacts/native-memory-e5-20260928");
const calibration = process.argv.includes("--calibrate");
const fullWeight = process.argv.includes("--full-weight-diagnostic");
const firstHoldout = process.argv.includes("--diagnostic-first-holdout");
const unknownCalibration = ["我的冰箱品牌是什么？", "我出生时有多重？", "我的高考成绩是多少？",
  "我的浴室瓷砖颜色是什么？", "我儿子叫什么名字？", "我的房屋面积是多少？",
  "What are the opening hours of my local swimming pool?", "Who is the captain of my football team?",
  "What toothpaste do I use?", "What is the name of my driving instructor?",
  "Which floor do my grandparents live on?", "Where is my wedding certificate stored?"];

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const encoder = new E5Encoder();
  const started = performance.now();
  const model = await encoder.open();
  if (fullWeight) {
    const file=path.join(output,"model-f32.onnx");
    assert.equal(hashText(fs.readFileSync(file)),"ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665");
    await encoder.session.release();
    encoder.session=await encoder.ort.InferenceSession.create(file,{executionProviders:["cpu"],intraOpNumThreads:1,
      interOpNumThreads:1,executionMode:"sequential",logSeverityLevel:3});
    model.diagnosticWeight="float32-official";
  }
  const coldMs = performance.now() - started;
  const latencies = [], rows = [];
  const dataFile = path.join(__dirname, "fixtures", calibration
    ? "shoggoth-memory-p4-multilingual-v1.json" : firstHoldout
      ? "shoggoth-memory-e5-holdout-v1.json" : "shoggoth-memory-e5-holdout-v2.json");
  const dataBytes = fs.readFileSync(dataFile), data = JSON.parse(dataBytes);
  const dot = (a,b) => a.reduce((sum,value,i) => sum + value * b[i], 0);
  try {
    for (const language of calibration ? ["zh", "en", "mixed"] : ["text"]) {
      const fixture = memoryFixture({ now: 1000 });
      const vectors = [];
      try {
        for (const [index, record] of data.records.entries()) {
          const text = record[language === "mixed" ? index % 2 ? "en" : "zh" : language];
          fixture.engine.propose({ id: record.id, profileId: "profile-1", scope: "user",
            type: "semantic", content: text, sourceRefs: [`synthetic-${record.id}`], classification: "explicit" });
          vectors.push({ id: record.id, language: sourceLanguage(text), vector: await encoder.encode(text) });
        }
        const queries = calibration ? data.queries.filter(row => row.corpusLanguage === language)
          .concat(language === "mixed" ? unknownCalibration.map(query => ({ query, relevant: [], group: "unanswerable" })) : []) : data.queries;
        for (const query of queries) {
          const start = performance.now();
          const vector = await encoder.encode(query.query, "query");
          const semantic = centerLanguageScores(vectors.map(row => ({ id: row.id,
            language:row.language,score: dot(vector, row.vector) })))
            .sort((a,b) => b.rankScore-a.rankScore || a.id.localeCompare(b.id));
          latencies.push(performance.now()-start);
          const input = { profileId: "profile-1", query: query.query, scopes: ["user"],
            maxSensitivity: "normal", limit: 5, maxBytes: 24*1024, now: 10_000 };
          const lexical = fixture.engine.search(input).items.map(row => row.id);
          const atCutoff = cutoff => fixture.engine.search({ ...input,
            semanticCandidates: semantic.filter(row => row.score >= cutoff).slice(0,100) }).items.map(row => row.id);
          rows.push({ query: query.query, group: query.group, relevant: query.relevant, lexical,
            vector: semantic.slice(0,5), hybrid: atCutoff(SEMANTIC_MIN_COSINE),
            ...(calibration ? { thresholds: Object.fromEntries([.70,.72,.74,.76,.78,.80,.82,.84,.86,.88,.90]
              .map(cutoff => [cutoff, atCutoff(cutoff)])) } : {}) });
        }
      } finally { fixture.cleanup(); }
    }
    const positives = rows.filter(row => row.relevant.length), negatives = rows.filter(row => !row.relevant.length);
    const metrics = (field, cutoff = null, selected = rows) => {
      const positives = selected.filter(row => row.relevant.length), negatives = selected.filter(row => !row.relevant.length);
      return { total: positives.length,
      r1: positives.filter(row => row.relevant.includes((cutoff === null ? row[field] : row.thresholds[cutoff])[0])).length,
      r5: positives.filter(row => (cutoff === null ? row[field] : row.thresholds[cutoff]).some(id => row.relevant.includes(id))).length,
      unknownVectorReturns: negatives.filter(row => row.vector[0]?.score >= (cutoff ?? SEMANTIC_MIN_COSINE)).length,
      unknownTotal: negatives.length,
      unknownRetrievalReturns: negatives.filter(row=>(cutoff === null ? row[field] : row.thresholds[cutoff]).length).length,
      precisionAt5: selected.reduce((sum,row) => sum + (cutoff===null ? row[field] : row.thresholds[cutoff])
        .slice(0,5).filter(id=>row.relevant.includes(id)).length, 0)/(selected.length*5) };
    };
    const thresholdMetrics = calibration ? Object.fromEntries([.70,.72,.74,.76,.78,.80,.82,.84,.86,.88,.90]
      .map(cutoff => [cutoff, metrics("hybrid",cutoff)])) : undefined;
    const sorted = [...latencies].sort((a,b)=>a-b);
    const report = { kind: calibration ? "calibration" : firstHoldout ? "seen-v1-diagnostic" : "independent-v2-new-topic-holdout", model,
      fixtureHash: hashText(dataBytes), cutoff: SEMANTIC_MIN_COSINE, coldMs,
      queryMs: { p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.floor(sorted.length*.95)] },
      rssBytes: process.memoryUsage().rss, lexical: metrics("lexical"), hybrid: metrics("hybrid"),
      groups: Object.fromEntries([...new Set(rows.map(row=>row.group))].map(group => [group,
        { lexical: metrics("lexical",null,rows.filter(row=>row.group===group)),
          hybrid: metrics("hybrid",null,rows.filter(row=>row.group===group)) }])),
      ...(thresholdMetrics ? { thresholdMetrics } : {}), rows };
    fs.writeFileSync(path.join(output, `${calibration ? "calibration" : firstHoldout ? "holdout-v1-diagnostic" : "holdout"}${fullWeight ? "-float32-diagnostic" : ""}.json`), JSON.stringify(report,null,2)+"\n");
    const { rows: omitted, ...summary } = report;
    console.log(JSON.stringify(summary));
    if (!calibration) {
      assert.ok(report.hybrid.r5 >= report.lexical.r5, "holdout top5 must not regress");
      assert.ok(report.hybrid.r5 >= positives.length*.9, "holdout top5 at least 90%");
      assert.ok(report.hybrid.precisionAt5 >= report.lexical.precisionAt5, "holdout precision must not regress");
      if (!firstHoldout) for (const [group, values] of Object.entries(report.groups)) {
        if (!values.hybrid.total) continue;
        assert.ok(values.hybrid.r5 >= values.hybrid.total*.9, group + " top5 at least 90%");
        if (/literal|identifier|exact/u.test(group)) assert.equal(values.hybrid.r1, values.hybrid.total);
      }
    }
  } finally { await encoder.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
