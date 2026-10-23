"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto"),{spawnSync}=require("node:child_process");
const {createAgentService}=require("../app/agent-service/server"),{resolveServicePaths}=require("../app/agent-service/paths"),{DEFAULT_AGENT_PROFILE_ID:profileId}=require("../app/agent-service/product-store");
const safeStorage={isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>Buffer.from(v).toString()};
const stable=v=>Array.isArray(v)?`[${v.map(stable).join(",")}]`:v&&typeof v==="object"?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`:JSON.stringify(v),sha=v=>crypto.createHash("sha256").update(v).digest("hex");
function crashed(t,phase){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"sfa-"));fs.chmodSync(root,0o700);let service;
 t.after(async()=>{if(service)await service.stop({notify:false});fs.rmSync(root,{recursive:true,force:true});});
 const result=spawnSync(process.execPath,[path.join(__dirname,"fresh-owner-atomic-child.cjs"),root,phase],{encoding:"utf8",env:process.env,timeout:20000});assert.equal(result.status,84,result.stderr);
 const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,"s"),profileRoot:path.join(root,"p"),cacheRoot:path.join(root,"c")}),directory=path.join(paths.agentsDir,profileId,"memory-native-initialization-v1"),manifest=path.join(directory,"owner.json"),staging=path.join(directory,"workspace-staging");
 const resume=async()=>{service=createAgentService({paths,safeStorage,prewarmMcpAuth:false,parentEnv:{},runtimeStorageHomedir:root,memoryCoreConfig:{memory:{search:{provider:"none",rememberAcrossConversations:false}}}});await service.start();return service;};
 return {root,paths,directory,manifest,staging,resume};
}
for(const phase of ["initial-temp","prepared-backup","prepared-published","active-backup","active-published","staging-memory-temp","staging-user-temp","staging-marker-temp"])test("actual stopped initializer recovers atomic owner "+phase,async t=>{
 const f=crashed(t,phase);let id;if(fs.existsSync(f.manifest))id=JSON.parse(fs.readFileSync(f.manifest,"utf8")).ownerId;
 const service=await f.resume(),owner=service.memoryEngine.initialization.assertOwned(profileId);assert.equal(owner.phase,"active");if(id)assert.equal(owner.ownerId,id);
 assert.deepEqual(fs.readdirSync(f.directory),["owner.json"]);assert.equal(service.memoryStore.list(profileId).length,0);
 const workspace=service.memoryEngine.store.workspace(profileId);assert.deepEqual(fs.readdirSync(workspace).sort(),[".shoggoth-native-owner.json","MEMORY.md","USER.md","memory"].sort());
});
for(const kind of ["initial-temp-hardlink","backup-owner-mismatch","backup-extra-link","staging-temp-hardlink","staging-existing-backup"])test("fresh recovery preserves and rejects foreign "+kind,async t=>{
 const phase=kind==="initial-temp-hardlink"?"initial-temp":kind.startsWith("backup-")?"prepared-published":"staging-user-temp",f=crashed(t,phase);
 let artifact;if(kind==="initial-temp-hardlink"){artifact=f.manifest+".tmp";fs.linkSync(artifact,path.join(f.root,"foreign-link"));}
 if(kind.startsWith("backup-")){artifact=path.join(f.directory,fs.readdirSync(f.directory).find(name=>name.startsWith("owner.json.backup-")));
  if(kind==="backup-extra-link")fs.linkSync(artifact,path.join(f.root,"foreign-link"));
  else {const value=JSON.parse(fs.readFileSync(artifact,"utf8"));value.ownerId=crypto.randomUUID();value.initialFiles[".shoggoth-native-owner.json"]=sha(stable({schemaVersion:1,type:"memory.native-workspace",profileId,ownerId:value.ownerId,owner:value.owner,upstreamRevision:value.upstreamRevision})+"\n");delete value.checksum;value.checksum=sha(stable(value));fs.writeFileSync(artifact,stable(value)+"\n");}
 }
 if(kind==="staging-temp-hardlink"){artifact=path.join(f.staging,"USER.md.tmp");fs.linkSync(artifact,path.join(f.root,"foreign-link"));}
 if(kind==="staging-existing-backup"){artifact=path.join(f.staging,"MEMORY.md.backup-123-0000000000000000");fs.linkSync(path.join(f.staging,"MEMORY.md"),artifact);}
 const bytes=fs.readFileSync(artifact),pin=fs.lstatSync(artifact);await assert.rejects(f.resume());assert.deepEqual(fs.readFileSync(artifact),bytes);assert.equal(fs.lstatSync(artifact).ino,pin.ino);assert.equal(fs.lstatSync(artifact).nlink,pin.nlink);
});

test("actual owner recovery binds the parser fd to the originally pinned backup",async t=>{
 const f=crashed(t,"prepared-published"),backup=path.join(f.directory,fs.readdirSync(f.directory).find(name=>name.startsWith("owner.json.backup-"))),foreign=path.join(f.root,"same-byte-foreign"),kept=path.join(f.root,"kept-original"),bytes=fs.readFileSync(backup);
 fs.writeFileSync(foreign,bytes,{mode:0o600});const original=fs.lstatSync(backup),foreignPin=fs.lstatSync(foreign),realStat=fs.lstatSync,realOpen=fs.openSync;let stats=0,swapped=false,opened=false,foreignFd;
 fs.lstatSync=function(target,...args){if(target===backup&&++stats===3){fs.renameSync(backup,kept);fs.renameSync(foreign,backup);swapped=true;}return realStat.call(this,target,...args);};
 fs.openSync=function(target,...args){const fd=realOpen.call(this,target,...args);if(target===backup&&swapped){opened=true;foreignFd=fd;fs.renameSync(backup,foreign);fs.renameSync(kept,backup);swapped=false;}return fd;};
 try{await assert.rejects(f.resume(),error=>error.code==="MEMORY_NATIVE_OWNER_INVALID");}finally{fs.lstatSync=realStat;fs.openSync=realOpen;if(swapped){fs.renameSync(backup,foreign);fs.renameSync(kept,backup);}}
 assert.equal(opened,true);assert.throws(()=>fs.fstatSync(foreignFd),{code:"EBADF"});assert.equal(fs.lstatSync(backup).ino,original.ino);assert.equal(fs.lstatSync(foreign).ino,foreignPin.ino);assert.deepEqual(fs.readFileSync(backup),bytes);
});
