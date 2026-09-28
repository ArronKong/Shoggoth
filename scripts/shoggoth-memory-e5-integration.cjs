"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { NativeMemorySemanticService } = require("../app/agent-service/native-memory-semantic-service");
const { LocalEmbeddingService } = require("../app/agent-service/local-embedding-service");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { openDatabase } = require("../app/agent-service/inspiration-database");
const { workspaceMemoryRef } = require("../app/agent-service/memory-engine");
const { E5_MODEL, e5AssetDirectory } = require("../app/agent-service/e5-model-contract");
const { E5Encoder } = require("../app/agent-service/e5-encoder");
const id = () => crypto.randomUUID();
const f = memoryFixture({ now: Date.now() });
const semantic = new NativeMemorySemanticService({ paths: f.paths, memoryEngine: f.engine });
f.engine.setSemanticSearchService(semantic);
const profileId = "profile-1";
const add = (content, extra = {}) => f.engine.propose({ profileId, content, scope: "user",
  type: "semantic", sourceRefs: [id()], classification: "explicit", ...extra });
const search = query => semantic.searchMemory({ profileId, query, workspace: "/project-a",
  maxSensitivity: "private", limit: 20, maxBytes: 24*1024 });
async function readyMemory() {
  const job = semantic.ensureMemory(profileId); await job.promise;
  assert.equal(job.state, "ready", JSON.stringify(semantic.status(profileId)));
}

async function main() {
  let recall, transcripts;
  try {
    const target = add("我养的宠物是一只叫栗子的仓鼠。");
    add("城东的花店每周二休息。");
    const project = add("雨燕工程采用蓝绿色包装。", { scope: "project",
      sourceRefs: [id(), workspaceMemoryRef("/project-a")] });
    const other = add("雨燕工程采用橙色包装。", { scope: "project",
      sourceRefs: [id(), workspaceMemoryRef("/project-b")] });
    const restricted = add("保密项目的观察仪器代号是黑梭。");
    // Primary storage can contain legacy restricted records; proposal API
    // correctly rejects creating them. Search still must exclude them.
    f.store.upsert({ ...restricted, sensitivity: "restricted" });
    const privateItem = add("我使用远程办公，私人住址在城南。", { sensitivity: "private" });
    const expired = add("我的通行证在本周临时有效。", { validUntil: f.engine.now()+20, type: "temporary" });
    await readyMemory();
    const original = f.engine.search({ profileId, query: "What is my hamster called?" });
    assert.ok(!original.items.some(row=>row.id===target.id));
    const found = await search("What is my hamster called?");
    assert.equal(found.semantic.status, "ready");
    assert.equal(found.items[0].id, target.id);
    assert.equal(found.items[0].scoreBasis, "e5-language-centered-cosine");
    const filtered = await search("雨燕产品的包装颜色");
    assert.ok(filtered.items.some(row=>row.id===project.id));
    assert.ok(!filtered.items.some(row=>row.id===other.id || row.id===restricted.id));
    const normal = await semantic.searchMemory({ profileId, query: "Where is my private home?",
      workspace: "/project-a", maxSensitivity: "normal" });
    assert.ok(!normal.items.some(row=>row.id===privateItem.id));
    f.setNow(Date.now()+10000);
    assert.ok(!(await search("temporary pass validity")).items.some(row=>row.id===expired.id));
    console.log("PASS real E5 child: bilingual paraphrase, workspace, private/restricted and TTL gates");

    const edited = f.engine.update({ profileId, id: target.id, expectedRevision: f.store.getRevision(profileId),
      content: "我养的宠物是一只叫松子的仓鼠。" });
    await readyMemory();
    assert.ok(!(await search("栗子")).items.some(row=>row.content.includes("叫栗子")));
    const current = await search("What is my hamster called?");
    assert.ok(current.items.some(row=>row.id===edited.id && row.content.includes("松子")));
    f.engine.delete({ profileId, id: edited.id, reason: "forgotten" });
    assert.ok(!(await search("What is my hamster called?")).items.some(row=>row.id===edited.id));
    await readyMemory();
    const indexFile = path.join(f.paths.agentsDir,profileId,"native-memory-semantic.sqlite");
    const db = openDatabase(indexFile);
    assert.ok(!db.prepare("SELECT source FROM documents").all().some(row=>JSON.parse(row.source).sourceId===edited.id));
    db.close();
    console.log("PASS edit/forget removes authoritative results and stale vector documents");

    transcripts = new TranscriptStore({ paths: f.paths, assertSecretSafe:()=>true }); transcripts.open();
    const sessions = [0,1].map(()=>({ id:id(),sessionKey:id(),profileId,workspace:"/project-a",status:"ready" }));
    for (const session of sessions) transcripts.ensureSession({ profileId,sessionId:session.id });
    const runs = sessions.map(session=>({ id:id(),profileId,source:"chat",sourceId:session.sessionKey,
      workspace:session.workspace,status:"running" }));
    const past = transcripts.appendEvent({ id:id(), profileId, sessionId:sessions[0].id,
      runId:runs[0].id,kind:"user",content:{text:"我的观鸟望远镜采用八倍放大和四十二毫米口径。"} });
    transcripts.appendEvent({ id:id(),profileId,sessionId:sessions[1].id,runId:runs[1].id,
      kind:"user",content:{text:"查询以前的设备参数"} });
    const store = { listSessions:()=>structuredClone(sessions),getSession:key=>structuredClone(sessions.find(row=>row.sessionKey===key)),
      getCronSessionOrigin:()=>null,getRevision:()=>1 };
    f.engine.transcriptStore=transcripts; f.engine.chatSessionStore=store;
    recall = new ConversationRecallService({ paths:f.paths,transcriptStore:transcripts,chatSessionStore:store,
      workDispatcher:{getRun:key=>runs.find(row=>row.id===key)},getRunSessionKey:run=>run.sourceId,
      recallPolicy:f.engine.recallPolicy,memoryStore:f.store,semanticSearch:semantic,now:f.engine.now });
    const args = { source:"chat",sourceId:runs[1].sourceId,query:"What magnification do my binoculars use?",limit:5 };
    const job=recall._ensureSemantic(profileId); await job.promise;
    assert.equal(job.state,"ready",JSON.stringify(semantic.status(profileId,"conversation")));
    const recalled=await recall.searchWithSemantic({profileId,args,run:runs[1]});
    assert.ok(recalled.results.some(row=>row.eventId===past.id && row.semanticEvidence && row.snippet.includes("八倍")));
    recall.assertResultCurrent({ name:"conversation_search",profileId,args,run:runs[1],result:recalled });
    for (const run of [{...runs[1],source:"cron"},{...runs[1],profileId:"another-agent"},
      {...runs[1],workspace:"/project-b"},{...runs[1],idempotencyKey:"shoggoth:chat-send:federation-send-evil"}]) {
      await assert.rejects(()=>recall.searchWithSemantic({profileId,args,run}));
    }
    transcripts.setContextExcluded({profileId,sessionId:sessions[0].id,eventId:past.id,contextExcluded:true});
    assert.throws(()=>recall.assertResultCurrent({name:"conversation_search",profileId,args,run:runs[1],result:recalled}));
    const after=await recall.searchWithSemantic({profileId,args,run:runs[1]});
    assert.ok(!after.results.some(row=>row.eventId===past.id));
    console.log("PASS real E5 conversation: original hash/range recheck and direct caller gates; exclusion revokes prior result");

    // Corruption never authorizes old data and a disposable cache can rebuild.
    const corrupt = openDatabase(indexFile);
    corrupt.prepare("UPDATE vectors SET vector_hash=? WHERE domain='memory'").run("0".repeat(64)); corrupt.close();
    await readyMemory();
    const fallback=await search("雨燕工程包装颜色");
    assert.ok(["unavailable","ready","rebuilding"].includes(fallback.semantic.status));
    await readyMemory();
    assert.equal((await search("雨燕工程包装颜色")).semantic.status,"ready");
    console.log("PASS damaged vector cache degrades safely and rebuilds");
    for (const damage of ["missing-vector", "missing-file"]) {
      if (damage === "missing-vector") {
        const broken = openDatabase(indexFile);
        broken.prepare("DELETE FROM vectors WHERE domain='memory'").run(); broken.close();
      } else fs.unlinkSync(indexFile);
      const degraded = await search("雨燕工程包装颜色");
      assert.equal(degraded.semantic.status, "unavailable");
      await readyMemory();
      assert.equal((await search("雨燕工程包装颜色")).semantic.status, "ready");
    }
    console.log("PASS real child detects removed vectors/files and parent resumes automatic rebuilding");

    const encoder=new E5Encoder(); await encoder.open();
    const long=("这是保留原话的段落 🦑 cafe\u0301。 ").repeat(800);
    const ranges=encoder.splitText(long);
    assert.ok(ranges.length>1 && ranges[0].start===0 && ranges.at(-1).end===long.length);
    for(const range of ranges) { assert.ok(long.slice(range.start,range.end).isWellFormed()); assert.ok(encoder.tokenize(long.slice(range.start,range.end)).length<=384); }
    await encoder.close();
    console.log("PASS long Unicode transcript chunks preserve source ranges and token bounds");

    recall.close(); recall=null; transcripts.close(); transcripts=null;
    await semantic.close();
    assert.deepEqual(semantic.embedding.lastExit,{code:0,signal:null});
    const bad=new LocalEmbeddingService({paths:f.paths,assetDirectory:path.join(f.root,"missing-model")});
    await assert.rejects(()=>bad.start()); await bad.close();
    assert.equal(bad.state,"closed");
    console.log("PASS natural inference-child exit; missing offline model is unavailable without download");
    console.log(JSON.stringify({verified:true,modelId:E5_MODEL.modelId,revision:E5_MODEL.revision,
      assetDirectory:e5AssetDirectory(),architecture:process.arch,naturalExit:semantic.embedding.lastExit}));
  } finally { recall?.close(); transcripts?.close(); await semantic.close(); f.cleanup(); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
