"use strict";

const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {atomicWritePrivateFile,readPrivateFile,validateDirectoryStat,validatePrivateStat,recoverInterruptedPrivateFile,fsyncPrivateParent}=require("../private-file");
const {ensurePrivateDirectoryTree,serviceError}=require("../security");
const {acquirePrivateWriterLease}=require("../private-writer-lease");
const {transaction}=require("../inspiration-database");
const {TurnMemo,databaseChangeStamp}=require("../turn-memo");
const {createMemoryVolumeIdentityResolver,isVolumeIdentity}=require("./memory-volume-identity.cjs");
const UPSTREAM="c10679395819ede78bb073f979f95c157e165bfa",OWNER="shoggoth-memory-core";
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u,HASH=/^[a-f0-9]{64}$/u,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`:JSON.stringify(value);
const sha=value=>crypto.createHash("sha256").update(value).digest("hex");
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const equal=(a,b)=>stable(a)===stable(b),exists=target=>{try{fs.lstatSync(target);return true;}catch(error){if(error.code==="ENOENT")return false;throw error;}};
const fail=(message,code="MEMORY_NATIVE_OWNER_INVALID")=>{throw serviceError(code,message);};
const profilePin=target=>{const s=validateDirectoryStat(fs.lstatSync(target),target);if(fs.realpathSync.native(target)!==target)fail("记忆目录归属路径已变化");return{dev:s.dev,ino:s.ino,mode:s.mode,uid:s.uid};};
const bodyOf=manifest=>Object.fromEntries(["schemaVersion","type","profileId","ownerId","owner","upstreamRevision","createdAt","profileIdentity","initialFiles",...(manifest.schemaVersion===2?["volumeIdentity"]:[])].map(key=>[key,manifest[key]]));
const validPin=value=>exact(value,["dev","ino","mode","uid"])&&Object.values(value).every(n=>Number.isSafeInteger(n)&&n>=0);
const checksum=value=>sha(stable(Object.fromEntries(Object.entries(value).filter(([key])=>key!=="checksum"))));

// A new owner is issued only from an empty Profile's memory namespace. There
// is no legacy reader, decoded legacy snapshot, import or migration checkpoint.
// The private intent and SQLite anchor bind later restarts to that same owner.
class FreshMemoryInitialization {
 constructor({paths,database,now=Date.now,randomUUID=crypto.randomUUID,fault=()=>{},resolveVolumeIdentity=createMemoryVolumeIdentityResolver()}){this.paths=paths;this.database=database;this.now=now;this.randomUUID=randomUUID;this.fault=fault;this.resolveVolumeIdentity=resolveVolumeIdentity;this.ownedChecks=new TurnMemo();}
 _volume(l){const identity=this.resolveVolumeIdentity(l.profileDir);if(!isVolumeIdentity(identity)||[this.paths.trustedRoot,this.paths.stateDir].some(target=>this.resolveVolumeIdentity(target)!==identity))fail("记忆归属目录不在受信存储卷内");return identity;}
 _matchesDirectory(target,saved,m){if(!validPin(saved))return false;const current=profilePin(target);if(["ino","mode","uid"].some(key=>current[key]!==saved[key]))return false;
  if(m.schemaVersion===2)return this.resolveVolumeIdentity(target)===m.volumeIdentity;
  // v1 has no historical volume UUID. Only an already active, anchored owner
  // can retain its inode across a mount-number change; prepared v1 stays strict.
  return current.dev===saved.dev||m.phase==="active"&&this.resolveVolumeIdentity(target).startsWith("darwin-volume:");
 }
 _legacyVolumeSeal(m){const db=this.database.db;if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_native_owner_volumes'").get())return null;
  return db.prepare("SELECT owner_id,authority_hash,volume_identity FROM memory_native_owner_volumes WHERE profile_id=?").get(m.profileId)||null;
 }
 _assertVolume(l,m){const identity=this._volume(l);if(m.schemaVersion===2){if(m.volumeIdentity!==identity)fail("原生记忆所在卷已变化");return identity;}
  const seal=this._legacyVolumeSeal(m);if(seal&&(seal.owner_id!==m.ownerId||seal.authority_hash!==sha(stable(bodyOf(m)))||seal.volume_identity!==identity))fail("原生记忆旧版卷归属已变化");return identity;
 }
 _bindLegacyVolume(m){if(m.schemaVersion!==1)return m;
  // Existing owner bytes and SQLite anchors are immutable. Add the missing
  // stable volume binding in one SQLite transaction after proving both dirs,
  // their private owner marker and the original authority hash. No reissue.
  transaction(this.database.db,()=>{const owned=this.assertOwned(m.profileId),l=this.locations(m.profileId),identity=this._assertVolume(l,owned);
   if(!this._legacyVolumeSeal(owned))this.database.db.prepare("INSERT INTO memory_native_owner_volumes VALUES (?,?,?,?)").run(m.profileId,owned.ownerId,sha(stable(bodyOf(owned))),identity);
   this.assertOwned(m.profileId);
  });return this.assertOwned(m.profileId);
 }
 locations(profileId){if(!ID.test(profileId||""))fail("记忆 Profile 标识无效");const profileDir=path.join(this.paths.agentsDir,profileId),directory=path.join(profileDir,"memory-native-initialization-v1");return{profileDir,directory,manifest:path.join(directory,"owner.json"),staging:path.join(directory,"workspace-staging"),workspace:path.join(profileDir,"memory-workspace"),lock:path.join(profileDir,"memory-native-initialization.writer.lock")};}
 _files(manifest){return{"MEMORY.md":"# Memory\n\n","USER.md":"# User\n\n",".shoggoth-native-owner.json":stable({schemaVersion:1,type:"memory.native-workspace",profileId:manifest.profileId,ownerId:manifest.ownerId,owner:OWNER,upstreamRevision:UPSTREAM})+"\n"};}
 _save(locations,manifest){this.ownedChecks.clear();manifest={...manifest,checksum:checksum(manifest)};atomicWritePrivateFile(locations.manifest,stable(manifest)+"\n",{trustedRoot:this.paths.trustedRoot});return manifest;}
 _read(locations,profileId,expectedIdentity){
  const sourceFs=expectedIdentity?Object.assign(Object.create(fs),{fstatSync(fd){const stat=fs.fstatSync(fd);if(stat.dev!==expectedIdentity.dev||stat.ino!==expectedIdentity.ino)fail("首次初始化恢复文件 fd 已变化");return stat;}}):fs;
  const m=JSON.parse(readPrivateFile(locations.manifest,{maxBytes:16384,fs:sourceFs}).toString("utf8"));
  if(!exact(m,["schemaVersion","type","profileId","ownerId","owner","upstreamRevision","createdAt","profileIdentity","initialFiles","phase","workspaceIdentity","checksum",...(m?.schemaVersion===2?["volumeIdentity"]:[])])||![1,2].includes(m.schemaVersion)||m.type!=="memory.native-initialization"||m.profileId!==profileId||!UUID.test(m.ownerId||"")||m.owner!==OWNER||m.upstreamRevision!==UPSTREAM||!Number.isSafeInteger(m.createdAt)||m.createdAt<0||!["prepared","active"].includes(m.phase)||!HASH.test(m.checksum||"")||checksum(m)!==m.checksum||!this._matchesDirectory(locations.profileDir,m.profileIdentity,m))fail("首次记忆初始化权威不可验证");
  if(m.schemaVersion===2&&(!isVolumeIdentity(m.volumeIdentity)||m.volumeIdentity!==this._volume(locations)))fail("首次记忆卷归属不可验证");
  if(!exact(m.initialFiles,Object.keys(this._files(m)))||!equal(m.initialFiles,Object.fromEntries(Object.entries(this._files(m)).map(([name,text])=>[name,sha(text)]))))fail("首次记忆文件权威不可验证");
  if(m.workspaceIdentity!==null&&!validPin(m.workspaceIdentity))fail("首次记忆目录权威不可验证");
  return m;
 }
 _legacyAbsent(locations,{first=false}={}){
  const legacy=path.join(locations.profileDir,"memory"),migration=path.join(locations.profileDir,"memory-migration-shoggoth-v1");
  if(exists(migration)||exists(path.join(locations.workspace,".shoggoth-memory-migration.json")))fail("已有旧版记忆需要保留；此启动只支持已清空的全新安装", "MEMORY_FRESH_HOME_REQUIRED");
  if(exists(legacy)){profilePin(legacy);const names=fs.readdirSync(legacy);if(first?names.length:names.some(name=>["events.jsonl","snapshot.json"].includes(name)))fail("已有旧版记忆需要保留；不会自动读取或导入", "MEMORY_FRESH_HOME_REQUIRED");}
  if(first&&(exists(path.join(locations.profileDir,"recall-policy-installed.json"))||exists(path.join(this.paths.agentsDir,".recall-policy-installations",`${path.basename(locations.profileDir)}.json`))))fail("已有记忆撤回权威需要保留", "MEMORY_FRESH_HOME_REQUIRED");
 }
 _emptyRows(profileId){const db=this.database.db;
  if(db.prepare("SELECT 1 FROM memory_file_records WHERE profile_id=?").get(profileId)||db.prepare("SELECT 1 FROM memory_file_pending WHERE profile_id=?").get(profileId))fail("首次初始化不能接管已有原生记忆", "MEMORY_FRESH_HOME_REQUIRED");
 }
 _initialRows(profileId){const db=this.database.db,profile=db.prepare("SELECT revision,fingerprint FROM memory_file_profiles WHERE profile_id=?").get(profileId),history=db.prepare("SELECT data FROM memory_file_history WHERE profile_id=?").get(profileId);
  if(!profile||profile.revision!==0||profile.fingerprint!==""||!history||history.data!=="[]")fail("首次初始化数据库已发生后续变化");
 }
 _anchor(profileId,manifest){const row=this.database.db.prepare("SELECT owner_id,authority_hash FROM memory_native_owners WHERE profile_id=?").get(profileId);if(!row||row.owner_id!==manifest.ownerId||row.authority_hash!==sha(stable(bodyOf(manifest))))fail("原生记忆 SQLite owner 与私有初始化权威不同");}
 _initialWorkspace(directory,manifest){if(!this._matchesDirectory(directory,manifest.workspaceIdentity,manifest))fail("首次记忆工作目录被替换");
  if(!equal(fs.readdirSync(directory).sort(),[...Object.keys(manifest.initialFiles),"memory"].sort())||fs.readdirSync(path.join(directory,"memory")).length)fail("首次初始化不能接管后续记忆内容");profilePin(path.join(directory,"memory"));
  for(const [name,hash] of Object.entries(manifest.initialFiles))if(sha(readPrivateFile(path.join(directory,name)))!==hash)fail("首次记忆工作目录内容已经变化");
 }
 // Search, recall and every memory read assert ownership. One check per turn,
 // rerun after this class writes (cleared) or any database change (key).
 assertOwned(profileId){return structuredClone(this.ownedChecks.get(`${profileId}\0${databaseChangeStamp(this.database.db)}`,()=>this._assertOwned(profileId)));}
 _assertOwned(profileId){const locations=this.locations(profileId);profilePin(locations.directory);const manifest=this._read(locations,profileId);if(manifest.phase!=="active"||manifest.workspaceIdentity===null)fail("原生记忆初始化尚未完成");this._legacyAbsent(locations);this._anchor(profileId,manifest);this._assertVolume(locations,manifest);
  if(!this._matchesDirectory(locations.workspace,manifest.workspaceIdentity,manifest)||readPrivateFile(path.join(locations.workspace,".shoggoth-native-owner.json")).toString("utf8")!==this._files(manifest)[".shoggoth-native-owner.json"])fail("原生记忆工作目录 owner 已变化");return manifest;
 }
 _recoverManifest(l,profileId){
  this.ownedChecks.clear();
  if(!exists(l.directory))return;
  profilePin(l.directory);
  // Before first publication, only the fixed private temp is recoverable.
  // Unrelated files still prevent issuing a fresh owner.
  if(!exists(l.manifest)&&fs.readdirSync(l.directory).some(name=>name!=="owner.json.tmp"))return;
  const recovery=recoverInterruptedPrivateFile(l.manifest,{trustedRoot:this.paths.trustedRoot});
  if(recovery!=="uncertain")return;
  // The generic writer cannot interpret a published new target plus its old
  // backup. Here the fixed owner schema proves the exact two legal transitions.
  const names=fs.readdirSync(l.directory).filter(name=>/^owner\.json\.backup-[1-9][0-9]*-[a-f0-9]{16}$/u.test(name));
  if(names.length!==1)fail("首次初始化 backup 证据不唯一");
  const backup=path.join(l.directory,names[0]),targetPin=validatePrivateStat(fs.lstatSync(l.manifest),l.manifest),backupPin=validatePrivateStat(fs.lstatSync(backup),backup);
  const current=this._read(l,profileId,targetPin),previous=this._read({...l,manifest:backup},profileId,backupPin);
  if(!equal(bodyOf(current),bodyOf(previous))||previous.phase!=="prepared")fail("首次初始化 backup owner 不同");
  if(current.phase==="prepared"){
   if(previous.workspaceIdentity!==null||current.workspaceIdentity===null||!this._matchesDirectory(l.staging,current.workspaceIdentity,current))fail("首次初始化 prepared 转换证据无效");
   this._legacyAbsent(l,{first:true});this._emptyRows(profileId);
   const db=this.database.db;if(db.prepare("SELECT 1 FROM memory_native_owners WHERE profile_id=?").get(profileId)){this._anchor(profileId,current);this._initialRows(profileId);}
   else if(db.prepare("SELECT 1 FROM memory_file_profiles WHERE profile_id=?").get(profileId)||db.prepare("SELECT 1 FROM memory_file_history WHERE profile_id=?").get(profileId))fail("首次初始化数据库已有其他 owner");
  }else{
   if(current.workspaceIdentity===null||!equal(previous.workspaceIdentity,current.workspaceIdentity)||!equal(this.assertOwned(profileId),current))fail("首次初始化 active 转换证据无效");
  }
  for(const [file,pin]of [[l.manifest,targetPin],[backup,backupPin]]){const stat=validatePrivateStat(fs.lstatSync(file),file);if(["dev","ino","size","mtimeMs","ctimeMs"].some(key=>stat[key]!==pin[key]))fail("首次初始化 backup 在恢复前已变化");}
  fs.unlinkSync(backup);fsyncPrivateParent(l.directory);
 }
 run(profileId){this.ownedChecks.clear();const l=this.locations(profileId);ensurePrivateDirectoryTree(l.profileDir,this.paths.trustedRoot);const lease=acquirePrivateWriterLease({lockPath:l.lock,trustedRoot:this.paths.trustedRoot});let originalError,failed=false;
  try{this.database.db.exec("CREATE TABLE IF NOT EXISTS memory_native_owners (profile_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,authority_hash TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS memory_native_owner_volumes (profile_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,authority_hash TEXT NOT NULL,volume_identity TEXT NOT NULL) STRICT;");
   this._recoverManifest(l,profileId);
   if(exists(l.manifest)){profilePin(l.directory);let m=this._read(l,profileId);if(m.phase==="active")return this._bindLegacyVolume(this.assertOwned(profileId));
    return this._finish(l,m);
   }
   this._legacyAbsent(l,{first:true});this._emptyRows(profileId);
   if(exists(l.workspace)||this.database.db.prepare("SELECT 1 FROM memory_file_profiles WHERE profile_id=?").get(profileId)||this.database.db.prepare("SELECT 1 FROM memory_native_owners WHERE profile_id=?").get(profileId)||this._legacyVolumeSeal({profileId})||exists(l.directory)&&fs.readdirSync(l.directory).length)fail("已有未归属原生记忆，拒绝当作全新安装", "MEMORY_FRESH_HOME_REQUIRED");
   ensurePrivateDirectoryTree(l.directory,this.paths.trustedRoot);let m={schemaVersion:2,volumeIdentity:this._volume(l),type:"memory.native-initialization",profileId,ownerId:this.randomUUID(),owner:OWNER,upstreamRevision:UPSTREAM,createdAt:this.now(),profileIdentity:profilePin(l.profileDir),initialFiles:null,phase:"prepared",workspaceIdentity:null};
   m.initialFiles=Object.fromEntries(Object.entries(this._files(m)).map(([name,text])=>[name,sha(text)]));m=this._save(l,m);this.fault("after-prepared",profileId);return this._finish(l,m);
  }catch(error){originalError=error;failed=true;throw error;}
  finally{try{lease.release();}catch(error){if(!failed)throw error;if(originalError&&typeof originalError==="object")try{Object.defineProperty(originalError,"initializationCleanupError",{value:error});}catch{}}}
 }
 _finish(l,m){this._legacyAbsent(l,{first:true});this._emptyRows(m.profileId);
  if(exists(l.workspace)){
   if(m.workspaceIdentity===null)fail("首次初始化没有发布目录权威");this._initialWorkspace(l.workspace,m);this._anchor(m.profileId,m);this._initialRows(m.profileId);
  }else{
   if(m.workspaceIdentity===null){if(exists(l.staging)&&fs.readdirSync(l.staging).length)fail("未归属的首次初始化暂存内容");ensurePrivateDirectoryTree(l.staging,this.paths.trustedRoot);m=this._save(l,{...m,workspaceIdentity:profilePin(l.staging)});}
   if(!this._matchesDirectory(l.staging,m.workspaceIdentity,m))fail("首次初始化暂存目录已替换");
   ensurePrivateDirectoryTree(path.join(l.staging,"memory"),this.paths.trustedRoot);
   for(const [name,text] of Object.entries(this._files(m))){const target=path.join(l.staging,name);if(exists(target)){if(readPrivateFile(target).toString("utf8")!==text)fail("首次初始化暂存内容已变化");}else atomicWritePrivateFile(target,text,{trustedRoot:this.paths.trustedRoot});}
   this._initialWorkspace(l.staging,m);this.fault("after-staged",m.profileId);
   transaction(this.database.db,()=>{this._legacyAbsent(l,{first:true});this._emptyRows(m.profileId);const db=this.database.db,row=db.prepare("SELECT owner_id,authority_hash FROM memory_native_owners WHERE profile_id=?").get(m.profileId),hash=sha(stable(bodyOf(m)));
    if(row){if(row.owner_id!==m.ownerId||row.authority_hash!==hash)fail("首次初始化数据库 owner 已变化");this._initialRows(m.profileId);}
    else{if(db.prepare("SELECT 1 FROM memory_file_profiles WHERE profile_id=?").get(m.profileId))fail("首次初始化数据库已有其他 owner");db.prepare("INSERT INTO memory_native_owners VALUES (?,?,?)").run(m.profileId,m.ownerId,hash);db.prepare("INSERT INTO memory_file_profiles VALUES (?,?,?)").run(m.profileId,0,"");db.prepare("INSERT INTO memory_file_history VALUES (?,?)").run(m.profileId,"[]");}
   });this.fault("after-database",m.profileId);this._initialWorkspace(l.staging,m);if(exists(l.workspace))fail("首次记忆发布路径已经被占用");fs.renameSync(l.staging,l.workspace);fsyncPrivateParent(l.profileDir);this.fault("after-published",m.profileId);
  }
  m=this._save(l,{...m,phase:"active"});this.fault("after-active",m.profileId);return this.assertOwned(m.profileId);
 }
}
module.exports={FreshMemoryInitialization,OWNER,UPSTREAM};
