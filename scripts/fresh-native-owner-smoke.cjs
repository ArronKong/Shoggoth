"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID: profileId } = require("../app/agent-service/product-store");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { OWNER, UPSTREAM } = require("../app/agent-service/shoggoth-memory/fresh-initialization.cjs");
const { readPrivateFile, atomicWritePrivateFile } = require("../app/agent-service/private-file");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const safeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v).toString("utf8") };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sfn-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root,"s"), profileRoot: path.join(root,"p"), cacheRoot: path.join(root,"c") });
  let service;
  const close = async () => { if(service) { await service.stop({notify:false}); service=null; } };
  const create = (options={}) => { service=createAgentService({paths,safeStorage,prewarmMcpAuth:false,
    memoryCoreConfig:{memory:{search:{provider:"none",rememberAcrossConversations:false}},agents:{defaults:{compaction:{memoryFlush:{enabled:false}}}}},
    version:"fresh-native-owner-isolated",...options}); return service; };
  const open = async options => { const current=create(options); await current.start(); return current; };
  t.after(async()=>{await close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,paths,open,create,close,adopt:current=>{service=current;}};
}
function ownerLocations(f) { const p=path.join(f.paths.agentsDir,profileId);return {profile:p,legacy:path.join(p,"memory"),workspace:path.join(p,"memory-workspace"),
  directory:path.join(p,"memory-native-initialization-v1"),manifest:path.join(p,"memory-native-initialization-v1","owner.json")}; }
function inventory(root) { const output=[]; const walk=relative=>{const target=path.join(root,relative),s=fs.lstatSync(target);output.push({path:relative,dev:s.dev,ino:s.ino,mode:s.mode,uid:s.uid,type:s.isDirectory()?"directory":"file",...(s.isFile()?{hash:sha(fs.readFileSync(target)),size:s.size}:{})});
  if(s.isDirectory())for(const name of fs.readdirSync(target).sort())walk(path.join(relative,name));};walk("");return output; }
const propose = (service,content="Fresh telescope uses an amber calibration plate.") => service.memoryEngine.propose({profileId,scope:"agent",type:"semantic",classification:"explicit",content,sourceRefs:["user-edit:fresh-fixture"]});

test("default real Service initializes a private native owner and persists native facts over stop/reopen",async t=>{
  const f=fixture(t);let service=await f.open(),engine=service.memoryEngine;
  assert.equal(engine.owner,OWNER);assert.equal(engine.legacy,null);assert.equal(engine.migration,null);
  assert.equal(engine.owner,"shoggoth-memory-core");
  assert.equal(engine.database.path,path.join(f.paths.stateDir,"shoggoth-memory.sqlite"));
  const l=ownerLocations(f),before=engine.initialization.assertOwned(profileId),pin=fs.lstatSync(l.workspace);
  assert.equal(before.phase,"active");assert.equal(before.upstreamRevision,UPSTREAM);assert.equal(fs.statSync(l.manifest).mode&0o777,0o600);
  assert.equal(fs.existsSync(path.join(l.profile,"memory-migration-shoggoth-v1")),false);
  assert.equal(fs.existsSync(path.join(l.workspace,".shoggoth-memory-migration.json")),false);
  assert.equal(fs.existsSync(path.join(l.legacy,"events.jsonl")),false);assert.equal(fs.existsSync(path.join(l.legacy,"snapshot.json")),false);
  assert.equal(engine.database.db.prepare("SELECT count(*) n FROM memory_file_records WHERE profile_id=?").get(profileId).n,0);
  const item=await propose(service);assert.equal(item.status,"active");assert.equal(service.memoryStore.get(profileId,item.id).content,item.content);
  assert.match(engine.readCanonical(profileId,"MEMORY").content,/amber calibration/u);
  const revision=service.memoryStore.getRevision(profileId);assert.ok(revision>0);await f.close();service=await f.open();engine=service.memoryEngine;
  assert.equal(engine.initialization.assertOwned(profileId).ownerId,before.ownerId);assert.equal(fs.lstatSync(l.workspace).ino,pin.ino);
  assert.equal(service.memoryStore.get(profileId,item.id).content,item.content);assert.equal(service.memoryStore.getRevision(profileId),revision);
  const result=await engine.searchMemory({profileId,query:"amber calibration plate",minScore:0,maxSensitivity:"private",record:false});
  assert.ok(result.items.some(value=>value.id===item.id));
  await engine.delete({profileId,id:item.id,reason:"forgotten",operationId:"fresh-delete"});await f.close();service=await f.open();
  assert.equal(service.memoryStore.get(profileId,item.id).status,"deleted");assert.ok(!service.memoryEngine.readCanonical(profileId,"MEMORY").content.includes(item.content));
  assert.equal(fs.existsSync(path.join(l.legacy,"events.jsonl")),false);
});

test("explicit memoryCore false retains the original isolated legacy fixture composition",async t=>{
  const f=fixture(t),service=await f.open({memoryCore:false});assert.equal(service.memoryEngine.owner,undefined);
  const item=service.memoryEngine.propose({profileId,scope:"agent",type:"semantic",classification:"explicit",content:"Legacy isolated test note",sourceRefs:["user-edit:legacy-fixture"]});
  assert.equal(service.memoryStore.get(profileId,item.id).content,item.content);const l=ownerLocations(f);assert.ok(fs.existsSync(path.join(l.legacy,"events.jsonl")));assert.equal(fs.existsSync(l.directory),false);
});

test("nonempty old Home is refused without reading or changing old memory bytes",async t=>{
  const f=fixture(t);let service=await f.open({memoryCore:false});service.memoryEngine.propose({profileId,scope:"agent",type:"semantic",classification:"explicit",content:"The original legacy constellation note",sourceRefs:["user-edit:old-home"]});await f.close();
  const l=ownerLocations(f),before=inventory(l.legacy),reads=[],readOriginal=fs.readFileSync,openOriginal=fs.openSync;
  fs.readFileSync=function(target,...args){if(typeof target==="string"&&target.startsWith(l.legacy+path.sep))reads.push(target);return readOriginal.call(this,target,...args);};
  fs.openSync=function(target,...args){if(typeof target==="string"&&target.startsWith(l.legacy+path.sep))reads.push(target);return openOriginal.call(this,target,...args);};
  try{await assert.rejects(f.open(),{code:"MEMORY_FRESH_HOME_REQUIRED"});}finally{fs.readFileSync=readOriginal;fs.openSync=openOriginal;}
  await f.close();assert.deepEqual(reads,[]);assert.deepEqual(inventory(l.legacy),before);assert.equal(fs.existsSync(l.manifest),false);assert.equal(fs.existsSync(l.workspace),false);
});

test("unowned native workspace is refused instead of reissuing authority for its content",async t=>{
  const f=fixture(t);await f.open({memoryCore:false});await f.close();const l=ownerLocations(f);
  // Remove only this fixture's legacy empty initialization, then add an unowned native source.
  fs.rmSync(l.legacy,{recursive:true});fs.rmSync(path.join(l.profile,"recall-policy-installed.json"),{force:true});fs.rmSync(path.join(f.paths.agentsDir,".recall-policy-installations",profileId+".json"),{force:true});
  fs.mkdirSync(l.workspace,{mode:0o700});fs.writeFileSync(path.join(l.workspace,"MEMORY.md"),"# Existing unowned telescope\n",{mode:0o600});const before=inventory(l.workspace);
  await assert.rejects(f.open(),{code:"MEMORY_FRESH_HOME_REQUIRED"});await f.close();assert.deepEqual(inventory(l.workspace),before);assert.equal(fs.existsSync(l.manifest),false);
});

for(const phase of ["after-prepared","after-staged","after-database","after-published","after-active"])test("actual isolated Service resumes its own initial transaction after "+phase,async t=>{
  const f=fixture(t),service=f.create(),error=new Error("fresh interruption "+phase);service.memoryEngine.initialization.fault=current=>{if(current===phase)throw error;};
  await assert.rejects(service.start(),value=>value===error);await f.close();const l=ownerLocations(f),prepared=JSON.parse(fs.readFileSync(l.manifest,"utf8"));
  const resumed=await f.open(),active=resumed.memoryEngine.initialization.assertOwned(profileId);assert.equal(active.ownerId,prepared.ownerId);assert.equal(active.phase,"active");
  assert.equal(fs.existsSync(path.join(l.directory,"workspace-staging")),false);assert.equal(resumed.memoryStore.list(profileId).length,0);
  const item=await propose(resumed,"Recovered telescope phase "+phase);assert.equal(resumed.memoryStore.get(profileId,item.id).content,item.content);
});

test("prepared recovery refuses a changed native revision or history",async t=>{
  for(const kind of ["revision","history"]){const f=fixture(t),service=f.create(),error=new Error("prepared authority interruption");service.memoryEngine.initialization.fault=phase=>{if(phase==="after-database")throw error;};
    await assert.rejects(service.start(),value=>value===error);await f.close();const database=new MemoryDatabase({paths:f.paths});database.open();
    try{if(kind==="revision")database.db.prepare("UPDATE memory_file_profiles SET revision=7 WHERE profile_id=?").run(profileId);else database.db.prepare("UPDATE memory_file_history SET data=? WHERE profile_id=?").run('[{"foreign":true}]',profileId);}finally{database.close();}
    await assert.rejects(f.open(),{code:"MEMORY_NATIVE_OWNER_INVALID"});await f.close();assert.equal(fs.existsSync(ownerLocations(f).workspace),false);
  }
});

for(const kind of ["missing-manifest","changed-anchor","replaced-workspace","hardlinked-marker"])test("active native owner refuses "+kind+" without losing existing facts",async t=>{
  const f=fixture(t);let service=await f.open();const item=await propose(service),l=ownerLocations(f),bytes=fs.readFileSync(path.join(l.workspace,"MEMORY.md"));await f.close();
  if(kind==="missing-manifest")fs.unlinkSync(l.manifest);
  if(kind==="changed-anchor"){const db=new MemoryDatabase({paths:f.paths});db.open();try{db.db.prepare("UPDATE memory_native_owners SET owner_id=? WHERE profile_id=?").run(crypto.randomUUID(),profileId);}finally{db.close();}}
  if(kind==="replaced-workspace"){fs.renameSync(l.workspace,l.workspace+"-retained");fs.cpSync(l.workspace+"-retained",l.workspace,{recursive:true});}
  if(kind==="hardlinked-marker")fs.linkSync(path.join(l.workspace,".shoggoth-native-owner.json"),path.join(f.root,"foreign-marker-link"));
  await assert.rejects(f.open());await f.close();assert.deepEqual(fs.readFileSync(path.join(l.workspace,"MEMORY.md")),bytes);assert.match(bytes.toString("utf8"),new RegExp(item.id));
});

test("offline migration composition requires an explicit trusted Node option",()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"sfn-mode-"));fs.chmodSync(root,0o700);
  const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,"s"),profileRoot:path.join(root,"p"),cacheRoot:path.join(root,"c")});
  try{assert.throws(()=>createAgentService({paths,safeStorage,memoryCoreInitialization:"migration"}),{code:"MEMORY_INITIALIZATION_INVALID"});
    const service=createAgentService({paths,safeStorage,memoryCore:true,memoryCoreInitialization:"migration",prewarmMcpAuth:false});assert.equal(service.memoryEngine.initialization,null);assert.ok(service.memoryEngine.legacy);assert.ok(service.memoryEngine.migration);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test("the production process entry defaults to native owner and schedules no old Codex memory import",async t=>{
  const f=fixture(t),{EventEmitter}=require("node:events"),signals=new EventEmitter(),timers=[],originalTimer=global.setTimeout;
  const memoryHome=path.join(f.root,".codex","memories");fs.mkdirSync(memoryHome,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(memoryHome,"memory_summary.md"),"Old Codex memory must stay unread",{mode:0o600});
  const before=inventory(memoryHome),openOriginal=fs.openSync,oldOpens=[];
  fs.openSync=function(target,...args){if(typeof target==="string"&&target.startsWith(memoryHome+path.sep))oldOpens.push(target);return openOriginal.call(this,target,...args);};
  global.setTimeout=function(callback,delay,...args){if(String(callback).includes("codexMemoryImportService.run"))timers.push(delay);return originalTimer(callback,delay,...args);};
  let service;
  try{service=await require("../app/agent-service").startAgentServiceProcess({paths:f.paths,safeStorage,builtinCliProfiles:false,
    prewarmMcpAuth:false,parentEnv:{HOME:f.root,PATH:process.env.PATH},homeDirectory:f.root,signalEmitter:signals});f.adopt(service);
    assert.equal(service.memoryEngine.owner,OWNER);assert.equal(service.memoryEngine.legacy,null);
    assert.equal(service.memoryEngine.initialization.assertOwned(profileId).phase,"active");assert.deepEqual(timers,[]);assert.deepEqual(oldOpens,[]);
  }finally{global.setTimeout=originalTimer;fs.openSync=openOriginal;await f.close();signals.removeAllListeners();}
  assert.deepEqual(inventory(memoryHome),before);
});
