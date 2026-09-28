"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { performance } = require("node:perf_hooks");
const { E5Encoder, hashText } = require("../app/agent-service/e5-encoder");
const { NativeSemanticIndex } = require("../app/agent-service/native-semantic-index");
const { NativeMemorySemanticService } = require("../app/agent-service/native-memory-semantic-service");
const { transaction } = require("../app/agent-service/inspiration-database");
const { validateMemoryItem } = require("../app/agent-service/memory-store");
const { sourceLanguage } = require("../app/agent-service/memory-semantic-ranking");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const outputArgument = process.argv.find(arg=>arg.startsWith("--output="));
const output = outputArgument ? outputArgument.slice(9)
  : path.resolve(__dirname, "../.artifacts/native-memory-e5-20260928/performance.json");
assert.ok(path.isAbsolute(output) && !output.includes("\0") && output.isWellFormed());
const corpus = require("./fixtures/shoggoth-memory-e5-holdout-v2.json");
const sizes = (process.argv.find(arg=>arg.startsWith("--sizes=")) || "--sizes=10000,100000")
  .slice(8).split(",").map(Number);
assert.ok(sizes.length && sizes.every(size=>Number.isSafeInteger(size) && size>0 && size<=100000));
const percentile = (values, p) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
async function main() {
  const encoder = new E5Encoder(), model = await encoder.open(), samples = [];
  try {
    for (const row of corpus.records) {
      const vector = await encoder.encode(row.text), bytes = Buffer.from(vector.buffer);
      samples.push({ text: row.text, vector: bytes, vectorHash: hashText(bytes) });
    }
  } finally { await encoder.close(); }
  const rows = [];
  for (const size of sizes) {
    const f = memoryFixture({ now: Date.now() });
    let semantic, index;
    try {
      const state = f.store.profiles.get("profile-1"), now = Date.now();
      // Bulk seed a valid synthetic snapshot to avoid timing O(n) snapshot
      // rewrites after every 128 imports. Queries use the real MemoryStore,
      // policy, MemoryEngine, worker IPC, ONNX encoder and source projection.
      for (let i=0;i<size;i++) state.items.set("perf-" + String(i).padStart(6,"0"),
        validateMemoryItem({ id: "perf-" + String(i).padStart(6,"0"), profileId: "profile-1",
          scope: "user", type: "semantic", content: samples[i%samples.length].text,
          sourceRefs: ["perf-source-" + i], confidence: 1, sensitivity: "normal", status: "active",
          validFrom: 0, validUntil: null, supersedes: null, createdAt: now-i, updatedAt: now-i }, "profile-1"));
      f.store._writeSnapshot(state); f.engine.rebuildViews("profile-1");
      const stamp = f.engine.semanticStamp("profile-1");
      index = new NativeSemanticIndex({ paths: f.paths, modelIdentity: model.identity });
      const { epoch } = index.begin("profile-1","memory",stamp), db = index._open("profile-1");
      const insertDocument = db.prepare("INSERT INTO documents(domain,id,content_hash,source,seen) VALUES('memory',?,?,?,?)");
      const insertVector = db.prepare("INSERT INTO vectors(domain,document_id,part,start_at,end_at,vector,vector_hash) VALUES('memory',?,0,0,?,?,?)");
      // These repeated texts use real batch=1 E5 vectors. This measures search
      // at scale, not cold encoding throughput or retrieval quality.
      const seedStart = performance.now();
      transaction(db, () => {
        let i=0;
        for (const item of state.items.values()) {
          const sample = samples[i++%samples.length], documentId = hashText("memory:" + item.id);
          insertDocument.run(documentId,hashText(item.content),JSON.stringify({
            sourceId:item.id, workspace:null, language:sourceLanguage(item.content), occurredAt:item.updatedAt,
            scope:"user",sensitivity:0,validFrom:0,validUntil:null,workspaceRefs:[] }),stamp);
          insertVector.run(documentId,item.content.length,sample.vector,sample.vectorHash);
        }
      });
      assert.deepEqual(index.commit("profile-1","memory",stamp,epoch), { documents:size,chunks:size });
      const indexSeedMs = performance.now()-seedStart;
      index.close(); index=null;
      semantic = new NativeMemorySemanticService({ paths:f.paths,memoryEngine:f.engine });
      const job = semantic.ensureMemory("profile-1"); await job.promise;
      assert.equal(job.state,"ready",JSON.stringify(semantic.status("profile-1")));
      const queries = corpus.queries.filter(row=>row.relevant.length && row.group !== "literal").slice(0,16).map(row=>row.query);
      const query = queries[0];
      const cold = performance.now();
      await semantic.embedding.request("query", {profileId:"profile-1",domain:"memory",stamp,query,
        filter:{now,workspaceRef:null,maxSensitivity:0},limit:60},{timeoutMs:20000});
      const firstQueryMs = performance.now()-cold;
      const times = [], statuses = {};
      for (let i=0;i<40;i++) {
        const start=performance.now();
        const result=await semantic.searchMemory({profileId:"profile-1",query:queries[i%queries.length],
          workspace:"/synthetic/perf",maxSensitivity:"normal",limit:20,maxBytes:24*1024});
        times.push(performance.now()-start);
        statuses[result.semantic.status]=(statuses[result.semantic.status]||0)+1;
        assert.ok(result.items.length<=20);
        assert.ok(result.items.every(item=>state.items.has(item.id)));
      }
      const stats = await semantic.embedding.request("stats", {});
      const indexBytes = fs.statSync(path.join(f.paths.agentsDir,"profile-1","native-memory-semantic.sqlite")).size;
      const row = { documents:size,chunks:size,iterations:times.length,indexSeedMs,
        firstQueryMs,warmQueryMs:{p50:percentile(times,.5),p95:percentile(times,.95),max:Math.max(...times)},
        statuses,indexBytes,parentRssBytes:process.memoryUsage().rss,worker:stats };
      rows.push(row); console.log(JSON.stringify(row));
      if(size<=10000){ assert.equal(statuses.ready,40); assert.ok(row.warmQueryMs.p95<=250); }
      assert.ok(stats.peakRssBytes<=1024*1024*1024, "Inference worker peak RSS must stay within the 1 GiB fixture budget");
      await semantic.close(); assert.deepEqual(semantic.embedding.lastExit,{code:0,signal:null});
    } finally { index?.close(); await semantic?.close(); f.cleanup(); global.gc?.(); }
  }
  const report = { verified:true,model,hardware:{arch:process.arch,platform:process.platform},
    measurement:"Native retrieval service, including real policy, encoder, vector IPC and authoritative source projection. Excludes UI, MCP socket, remote provider and cold corpus encoding.",
    repeatedCorpusTexts: samples.length,rows };
  fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n");
}
main().catch(error=>{console.error(error);process.exitCode=1});
