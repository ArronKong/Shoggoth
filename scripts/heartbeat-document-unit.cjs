"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {HeartbeatDocumentStore,parseHeartbeat,DEFAULT_HEARTBEAT,EMPTY_REVISION}=require("../app/agent-service/heartbeat-document");
const {ProactiveStore}=require("../app/agent-service/proactive-store");
const {resolveServicePaths}=require("../app/agent-service/paths");
const {validateParams,validateResult,validateResponse}=require("../app/agent-service/proactive-service-protocol");
test("empty templates skip; explicit web declarations are bounded and validated",()=>{
 assert.equal(parseHeartbeat(DEFAULT_HEARTBEAT).empty,true);
 assert.equal(parseHeartbeat("# Review\n<!-- notes -->\n- [ ]\n").empty,true);
 const value=parseHeartbeat("---\nweb:\n  - kind: fetch\n    url: https://example.com\n  - kind: search\n    query: new releases\n---\nNotify only if a new release is published.");
 assert.equal(value.web.length,2);assert.equal(value.empty,false);
 for(const source of ["---\nweb: !!js/function 'oops'\n---\n", "---\nweb:\n - kind: fetch\n   url: file:///etc/passwd\n---\n", "---\nweb:\n - kind: shell\n   command: rm\n---\n"])assert.throws(()=>parseHeartbeat(source));
});
test("documents are per-Agent, optimistic and do not initialize files on read",t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"sg-heartbeat-doc-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,"state"),profileRoot:path.join(root,"profile"),cacheRoot:path.join(root,"cache")});
 const docs=new HeartbeatDocumentStore({paths,productStore:{getAgentProfile:id=>["a","b"].includes(id)?{id}:null}});
 const initial=docs.read("a");assert.equal(initial.revision,EMPTY_REVISION);assert.equal(fs.existsSync(path.join(paths.agentsDir,"a","HEARTBEAT.md")),false);
 const next=docs.write("a","# Checks\nRead project status.",initial.revision);assert.equal(next.missing,false);assert.equal(docs.read("b").missing,true);
 assert.throws(()=>docs.write("a","Lost edit",initial.revision),{code:"PROACTIVE_REVISION_CONFLICT"});
 fs.writeFileSync(path.join(paths.agentsDir,"a","HEARTBEAT.md"),"External editor changed rules.");
 assert.throws(()=>docs.write("a","Lost external edit",next.revision),{code:"PROACTIVE_REVISION_CONFLICT"});
 fs.writeFileSync(path.join(paths.agentsDir,"a","HEARTBEAT.md"),"---\nweb: [invalid\n---\n");
 const broken=docs.read("a");assert.match(broken.content,/invalid/);docs.write("a","Repaired rules.",broken.revision);
 const victim=path.join(root,"victim");fs.writeFileSync(victim,"KEEP");fs.unlinkSync(path.join(paths.agentsDir,"a","HEARTBEAT.md"));fs.symlinkSync(victim,path.join(paths.agentsDir,"a","HEARTBEAT.md"));
 assert.throws(()=>docs.read("a"),{code:"PROACTIVE_DOCUMENT_INVALID"});assert.equal(fs.readFileSync(victim,"utf8"),"KEEP");
 assert.throws(()=>docs.read("../b"));
});
test("scratch revisions survive restart and reject stale replacements",t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"sg-heartbeat-db-"));
 const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,"state"),profileRoot:path.join(root,"profile"),cacheRoot:path.join(root,"cache")});
 const store=new ProactiveStore({paths});store.open();t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 assert.deepEqual(store.heartbeatScratch("a"),{revision:0,content:"",updatedAt:0});
 const saved=store.setHeartbeatScratch("a","Seen release 3.",0);assert.equal(saved.revision,1);
 assert.throws(()=>store.setHeartbeatScratch("a","Stale",0),{code:"PROACTIVE_REVISION_CONFLICT"});
 assert.equal(store.heartbeatScratch("b").content,"");store.close();store.open();assert.equal(store.heartbeatScratch("a").content,"Seen release 3.");
 const cleared=store.setHeartbeatScratch("a","",1);assert.equal(cleared.revision,2);
 assert.throws(()=>store.setHeartbeatScratch("a","\u0001".repeat(4096),2));
 store.purgeProfile("a");assert.equal(store.heartbeatScratch("a").revision,0);
});
test("IPC document and scratch contracts preserve full revisions",()=>{
 const params={profileId:"a",content:"# Checks",expectedRevision:EMPTY_REVISION};validateParams("proactive.document.set",params);
 assert.throws(()=>validateParams("proactive.document.set",{...params,expectedRevision:1}));
 validateResult("proactive.scratch.get",{scratch:{content:"",revision:0,updatedAt:0}});
 validateResponse({runId:"r",outcome:"silent",candidates:[],reason:"no change",body:"",scratch:"seen"});
});
