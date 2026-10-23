'use strict';
// SQLite readOnly:true can repair SHM. The original owned state is never opened
// by SQLite; only a stable disposable snapshot and pinned private Node snapshot are.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const {spawnSync}=require('node:child_process');
const pins=require('./managed-openclaw-runtime-pins.json');
const HASH=/^[a-f0-9]{64}$/,TOKEN=/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/;
const REVISION_SOURCE='dist/config-revision-token-BE5gb7qW.mjs',REVISION_SOURCE_SHA='d077635242bfb0c94a8e3b299e8e4f3854f5b01b2ccae8998127c26c6268b874';
const MAX_STATE_BYTES=512*1024*1024,RESERVE=2*1024**3,OBSERVER_CHILD_TIMEOUT_MS=10000;
const fail=code=>Object.assign(new Error(code),{code}),need=(value,code)=>{if(!value)throw fail(code);};
function plain(value){return value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return typeof key==='string'&&d.enumerable&&Object.hasOwn(d,'value');});}
function canonical(value){need(typeof value==='string'&&Buffer.byteLength(value)<=4096&&path.isAbsolute(value)&&path.normalize(value)===value&&fs.realpathSync(value)===value,'MANAGED_CONFIG_REVISION_PATH_UNSAFE');return value;}
function statFor(file,{directory=false,privateOnly=false}={}){const s=fs.lstatSync(file);need(!s.isSymbolicLink()&&(s.mode&(privateOnly?0o077:0o022))===0&&(!process.getuid||s.uid===process.getuid())&&(directory?s.isDirectory():s.isFile()&&s.nlink===1&&s.size<=MAX_STATE_BYTES),'MANAGED_CONFIG_REVISION_PATH_UNSAFE');return s;}
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino,stable=(a,b)=>same(a,b)&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
function fdHash(fd,changed='MANAGED_CONFIG_REVISION_CHANGED'){const stat=fs.fstatSync(fd),buffer=Buffer.allocUnsafe(65536),hash=crypto.createHash('sha256');let position=0;
 try{while(position<stat.size){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,stat.size-position),position);need(count>0,changed);hash.update(buffer.subarray(0,count));position+=count;}need(stable(stat,fs.fstatSync(fd)),changed);return hash.digest('hex');}finally{buffer.fill(0);}}
function snapshotCopy(entry,target){const out=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600),buffer=Buffer.allocUnsafe(65536);let position=0;
 try{while(position<entry.stat.size){const count=fs.readSync(entry.fd,buffer,0,Math.min(buffer.length,entry.stat.size-position),position);need(count>0,'MANAGED_CONFIG_REVISION_CHANGED');let written=0;while(written<count)written+=fs.writeSync(out,buffer,written,count-written,position+written);position+=count;}fs.fsyncSync(out);}finally{buffer.fill(0);fs.closeSync(out);}}
// Only this fixed query on a disposable snapshot; no schema/key creation or
// arbitrary SQL. Original database, WAL and SHM remain under held-fd hash fences.
const OBSERVER=String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');let database;const opened=[];
function check(file,dir){const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||(stat.mode&63)!==0||stat.uid!==process.getuid()||fs.realpathSync(file)!==file||(dir?!stat.isDirectory():!stat.isFile()||stat.nlink!==1))throw Error('unsafe');return stat;}
try{const file=process.argv[1],raw=process.argv[2],projected=process.argv[3];
 for(const dir of [path.dirname(path.dirname(file)),path.dirname(file)])check(dir,true);
 for(const target of [file,file+'-wal',file+'-shm']){const before=check(target,false),fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),stat=fs.fstatSync(fd);if(stat.dev!==before.dev||stat.ino!==before.ino)throw Error('changed');opened.push({target,fd,stat});}
 database=new DatabaseSync(file,{readOnly:true,timeout:1000});const row=database.prepare('SELECT hmac_key FROM config_revision_keys WHERE id = 1').get();
 if(!(row?.hmac_key instanceof Uint8Array)||row.hmac_key.byteLength!==32)throw Error('invalid key');
 const expected='hmac-sha256:v1:'+crypto.createHmac('sha256',row.hmac_key).update(JSON.stringify(['openclaw.gateway.config-revision.raw.v1',raw]),'utf8').digest('base64url');
 row.hmac_key.fill(0);database.close();database=null;
 for(const {target,fd,stat}of opened){const held=fs.fstatSync(fd),current=check(target,false);if(current.dev!==stat.dev||current.ino!==stat.ino||held.ino!==stat.ino)throw Error('changed');}
 process.stdout.write(JSON.stringify({matches:crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(projected))})+'\n');
}catch{process.stderr.write('MANAGED_CONFIG_REVISION_OBSERVER_FAILED\n');process.exitCode=1;}
finally{try{database?.close();}catch{}for(const {fd}of opened)try{fs.closeSync(fd);}catch{}}
`;
function matchesOnce(options){const keys=['runtimeRoot','dataRoot','interpreterPath','rawHash','projectedHash','deadlineAt','assertCurrent'];
 need(plain(options)&&Reflect.ownKeys(options).length===keys.length&&keys.every(key=>Object.hasOwn(options,key))&&typeof options.rawHash==='string'&&HASH.test(options.rawHash)&&typeof options.projectedHash==='string'&&TOKEN.test(options.projectedHash)&&Number.isSafeInteger(options.deadlineAt)&&typeof options.assertCurrent==='function','MANAGED_CONFIG_REVISION_INVALID');
 const guard=()=>{need(options.deadlineAt>Date.now(),'MANAGED_CONFIG_REVISION_DEADLINE');const valid=options.assertCurrent();need(valid===undefined||valid===true,'MANAGED_CONFIG_REVISION_RETIRED');};
 guard();const runtimeRoot=canonical(options.runtimeRoot),dataRoot=canonical(options.dataRoot),interpreter=canonical(options.interpreterPath),revisionSource=path.join(runtimeRoot,REVISION_SOURCE);
 const opened=[],anchors=[];let snapshotRoot=null,snapshotAnchor=null;
 function open(file,privateOnly,kind='source'){const before=statFor(canonical(file),{privateOnly}),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),stat=fs.fstatSync(fd),entry={file,fd,stat,privateOnly,kind,hash:null};opened.push(entry);need(same(before,stat),'MANAGED_CONFIG_REVISION_CHANGED');const changed=kind==='state'?'MANAGED_CONFIG_REVISION_STATE_BUSY':'MANAGED_CONFIG_REVISION_CHANGED';need(stable(before,stat),changed);entry.hash=fdHash(fd,changed);return entry;}
 function anchor(dir,privateOnly){const stat=statFor(canonical(dir),{directory:true,privateOnly});anchors.push({dir,stat,privateOnly});}
 const check=()=>{guard();for(const {dir,stat,privateOnly}of anchors)need(same(statFor(canonical(dir),{directory:true,privateOnly}),stat),'MANAGED_CONFIG_REVISION_CHANGED');for(const entry of opened){const current=statFor(canonical(entry.file),{privateOnly:entry.privateOnly}),held=fs.fstatSync(entry.fd);need(same(current,entry.stat)&&same(held,entry.stat),'MANAGED_CONFIG_REVISION_CHANGED');const changed=entry.kind==='state'?'MANAGED_CONFIG_REVISION_STATE_BUSY':'MANAGED_CONFIG_REVISION_CHANGED';need(stable(current,entry.stat)&&stable(held,entry.stat)&&fdHash(entry.fd,changed)===entry.hash,changed);}};
 try{
  for(const dir of [runtimeRoot,path.dirname(revisionSource),path.dirname(interpreter)])anchor(dir,false);
  const executable=open(interpreter,false);need(executable.hash===pins.hosts.openclaw.interpreter.sha256,'MANAGED_CONFIG_REVISION_INTERPRETER_UNSUPPORTED');
  const source=open(revisionSource,false);need(source.hash===REVISION_SOURCE_SHA,'MANAGED_CONFIG_REVISION_SOURCE_UNSUPPORTED');
  const dirs=[dataRoot,path.join(dataRoot,'state'),path.join(dataRoot,'state/state')];for(const dir of dirs)anchor(dir,true);
  const database=path.join(dirs[2],'openclaw.sqlite'),state=[database,database+'-wal',database+'-shm'].map(file=>open(file,true,'state')),total=state.reduce((sum,entry)=>sum+entry.stat.size,0);
  need(total<=MAX_STATE_BYTES,'MANAGED_CONFIG_REVISION_STATE_TOO_LARGE');const space=fs.statfsSync('/private/tmp');need(space.bavail*space.bsize>=RESERVE+total+executable.stat.size,'MANAGED_CONFIG_REVISION_DISK_RESERVE');check();
  snapshotRoot=fs.mkdtempSync('/private/tmp/sg-managed-config-proof-');fs.chmodSync(snapshotRoot,0o700);snapshotAnchor=statFor(canonical(snapshotRoot),{directory:true,privateOnly:true});anchor(snapshotRoot,true);
  const snapshotDir=path.join(snapshotRoot,'database');fs.mkdirSync(snapshotDir,{mode:0o700});anchor(snapshotDir,true);
  for(const entry of state){const target=path.join(snapshotDir,path.basename(entry.file));snapshotCopy(entry,target);const copied=open(target,true);need(!same(copied.stat,entry.stat),'MANAGED_CONFIG_REVISION_CHANGED');need(copied.hash===entry.hash,'MANAGED_CONFIG_REVISION_STATE_BUSY');opened.splice(opened.indexOf(copied),1);fs.closeSync(copied.fd);}
  const copiedExecutable=path.join(snapshotRoot,'pinned-node');snapshotCopy(executable,copiedExecutable);fs.chmodSync(copiedExecutable,0o500);
  const clone=open(copiedExecutable,true);need(!same(clone.stat,executable.stat)&&clone.hash===pins.hosts.openclaw.interpreter.sha256,'MANAGED_CONFIG_REVISION_INTERPRETER_UNSUPPORTED');
  // Source replacement cannot substitute the spawned binary. The independent
  // protected private clone itself is pinned and fenced before/after the effect.
  check();
  // Darwin can spend several seconds validating a fresh pinned executable.
  // This is only a fixed child-start ceiling under the original operation;
  // it grants no lease renewal and timeout is never retried as state churn.
  const observerTimeoutMs=Math.min(OBSERVER_CHILD_TIMEOUT_MS,options.deadlineAt-Date.now());
  need(observerTimeoutMs>0,'MANAGED_CONFIG_REVISION_DEADLINE');
  const child=spawnSync(copiedExecutable,['-e',OBSERVER,path.join(snapshotDir,'openclaw.sqlite'),options.rawHash,options.projectedHash],{encoding:'utf8',maxBuffer:4096,timeout:observerTimeoutMs,killSignal:'SIGTERM',cwd:snapshotRoot,env:{HOME:snapshotRoot,PATH:snapshotRoot+':/usr/bin:/bin',LANG:'en_US.UTF-8',TMPDIR:'/private/tmp'}});
  check();need(!child.error&&child.status===0&&child.signal===null,'MANAGED_CONFIG_REVISION_OBSERVER_FAILED');let result;try{result=JSON.parse(child.stdout);}catch{throw fail('MANAGED_CONFIG_REVISION_PROOF_INVALID');}
  need(plain(result)&&Reflect.ownKeys(result).length===1&&typeof result.matches==='boolean','MANAGED_CONFIG_REVISION_PROOF_INVALID');return result.matches;
 }finally{for(const {fd}of opened)fs.closeSync(fd);if(snapshotRoot&&snapshotAnchor&&same(fs.lstatSync(snapshotRoot),snapshotAnchor))fs.rmSync(snapshotRoot,{recursive:true,force:true});}
}
// SQLite's real writer may checkpoint/update WAL/SHM while paused. No partial
// snapshot is accepted: at most three complete attempts under the original
// deadline, and only same-inode state content/metadata churn may be retried.
// Source/executable/root/owner replacement or invalid schema/key is fatal.
function matchesManagedConfigRevision(options){for(let attempt=0;attempt<3;attempt++){try{return matchesOnce(options);}catch(error){if(error.code!=='MANAGED_CONFIG_REVISION_STATE_BUSY'||attempt===2)throw error;}}}
module.exports={matchesManagedConfigRevision};
