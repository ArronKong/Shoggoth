'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');const {matchesManagedConfigRevision}=require('../app/managed-openclaw-config-revision');
const node=(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node'));const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-config-revision-'));fs.chmodSync(root,0o700);
const mkdir=value=>{fs.mkdirSync(value,{recursive:true,mode:0o700});return value;};const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const runtimeRoot=mkdir(path.join(root,'runtime'));mkdir(path.join(runtimeRoot,'dist'));const revisionFile=path.join(runtimeRoot,'dist/config-revision-token-BE5gb7qW.mjs');
fs.copyFileSync('/opt/homebrew/lib/node_modules/openclaw/dist/config-revision-token-BE5gb7qW.mjs',revisionFile);
const keeper=path.join(root,'keeper.cjs');fs.writeFileSync(keeper,`process.umask(0o077);const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA journal_mode=WAL');
if(process.argv[3]==='missing'){db.exec('CREATE TABLE only_fixture(id INTEGER PRIMARY KEY)');db.exec('INSERT INTO only_fixture VALUES(1)');}
else{db.exec('CREATE TABLE config_revision_keys(id INTEGER PRIMARY KEY, hmac_key BLOB)');db.prepare('INSERT INTO config_revision_keys VALUES(1,?)').run(Buffer.alloc(process.argv[3]==='short'?31:32,7));}
db.prepare('SELECT name FROM sqlite_schema').all();process.send('ready');process.on('message',()=>{db.close();process.disconnect();});`,{mode:0o600});
function observedHelper(intercept){const cp=require('node:child_process'),original=cp.spawnSync,resolved=require.resolve('../app/managed-openclaw-config-revision'),cached=require.cache[resolved];
 cp.spawnSync=function(...values){return intercept(original,...values);};
 try{delete require.cache[resolved];return require(resolved).matchesManagedConfigRevision;}
 finally{cp.spawnSync=original;require.cache[resolved]=cached;}}
const children=[];async function database(name,mode='valid'){const dataRoot=mkdir(path.join(root,name));mkdir(path.join(dataRoot,'state/state'));const file=path.join(dataRoot,'state/state/openclaw.sqlite');
 const child=fork(keeper,[file,mode],{execPath:node,env:{PATH:'/usr/bin:/bin',HOME:dataRoot},stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);children.push(child);
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('keeper early exit '+code+stderr)));});return {dataRoot,file};}
async function stop(child){if(child.exitCode!==null)return;await new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>code===0&&!signal?resolve():reject(Error('owned sqlite fixture failed to close')));child.send('stop');});}
const rawHash='a'.repeat(64);const projectedHash='hmac-sha256:v1:'+crypto.createHmac('sha256',Buffer.alloc(32,7)).update(JSON.stringify(['openclaw.gateway.config-revision.raw.v1',rawHash])).digest('base64url');
const args=dataRoot=>({runtimeRoot,dataRoot,interpreterPath:node,rawHash,projectedHash,deadlineAt:Date.now()+5000,assertCurrent(){}});
async function main(){const cases=[];try{
 const good=await database('good');const before=[good.file,good.file+'-wal',good.file+'-shm'].map(hash);const inode=fs.statSync(good.file).ino;
 assert.equal(matchesManagedConfigRevision(args(good.dataRoot)),true);assert.deepEqual([good.file,good.file+'-wal',good.file+'-shm'].map(hash),before);assert.equal(fs.statSync(good.file).ino,inode);
 cases.push('independent pinned Node24 snapshot reads stable disposable SQLite snapshot and matches exact HMAC; original main DB/WAL/SHM content and identity unchanged, no original key/schema/sidecar effects');
 assert.equal(matchesManagedConfigRevision({...args(good.dataRoot),rawHash:'b'.repeat(64)}),false);
 assert.equal(matchesManagedConfigRevision({...args(good.dataRoot),projectedHash:'hmac-sha256:v1:'+'X'.repeat(43)}),false);
 assert.throws(()=>matchesManagedConfigRevision({...args(good.dataRoot),projectedHash:rawHash}),e=>e.code==='MANAGED_CONFIG_REVISION_INVALID');
 cases.push('wrong raw hash/key token fails exact comparison; raw SHA or arbitrary revision formatting cannot be accepted as a fallback');
 for(const mode of ['missing','short']){const invalid=await database(mode,mode);const unchanged=[invalid.file,invalid.file+'-wal',invalid.file+'-shm'].map(hash);
  assert.throws(()=>matchesManagedConfigRevision(args(invalid.dataRoot)),e=>e.code==='MANAGED_CONFIG_REVISION_OBSERVER_FAILED');assert.deepEqual([invalid.file,invalid.file+'-wal',invalid.file+'-shm'].map(hash),unchanged);}
 const absent=mkdir(path.join(root,'absent'));mkdir(path.join(absent,'state/state'));assert.throws(()=>matchesManagedConfigRevision(args(absent)));assert.deepEqual(fs.readdirSync(path.join(absent,'state/state')),[]);
 cases.push('missing database/table/key or wrong32-byte key rejects without creating/repairing schema, database, key or sidecars');
 const link=path.join(root,'link');fs.symlinkSync(good.dataRoot,link);assert.throws(()=>matchesManagedConfigRevision(args(link)),e=>e.code==='MANAGED_CONFIG_REVISION_PATH_UNSAFE');
 fs.chmodSync(good.file,0o644);assert.throws(()=>matchesManagedConfigRevision(args(good.dataRoot)),e=>e.code==='MANAGED_CONFIG_REVISION_PATH_UNSAFE');fs.chmodSync(good.file,0o600);
 fs.linkSync(good.file,good.file+'.linked');assert.throws(()=>matchesManagedConfigRevision(args(good.dataRoot)),e=>e.code==='MANAGED_CONFIG_REVISION_PATH_UNSAFE');fs.unlinkSync(good.file+'.linked');
 cases.push('canonical owner-private directory/file, no-symlink, nlink1 and O_NOFOLLOW/dev-inode fences reject escaped/public/hardlinked state before any observer');
 const source=fs.readFileSync(revisionFile);fs.appendFileSync(revisionFile,'\n// changed');assert.throws(()=>matchesManagedConfigRevision(args(good.dataRoot)),e=>e.code==='MANAGED_CONFIG_REVISION_SOURCE_UNSUPPORTED');fs.writeFileSync(revisionFile,source);
 // The runner may itself use the pinned Node; choose distinct controlled bytes, not process.execPath.
 const differentInterpreter=path.join(root,'different-interpreter');fs.writeFileSync(differentInterpreter,'#!/bin/sh\nexit 99\n',{mode:0o500});
 assert.throws(()=>matchesManagedConfigRevision({...args(good.dataRoot),interpreterPath:differentInterpreter}),e=>e.code==='MANAGED_CONFIG_REVISION_INTERPRETER_UNSUPPORTED');
 cases.push('actual pinned revision implementation and exact interpreter hash required; source substitution and other Node are unsupported');
 assert.throws(()=>matchesManagedConfigRevision({...args(good.dataRoot),deadlineAt:Date.now()-1}),e=>e.code==='MANAGED_CONFIG_REVISION_DEADLINE');
 assert.throws(()=>matchesManagedConfigRevision({...args(good.dataRoot),assertCurrent:async()=>true}),e=>e.code==='MANAGED_CONFIG_REVISION_RETIRED');
 assert.throws(()=>matchesManagedConfigRevision({...args(good.dataRoot),database:'/elsewhere'}),e=>e.code==='MANAGED_CONFIG_REVISION_INVALID');
 const inherited=Object.assign(Object.create({ready:true}),args(good.dataRoot));assert.throws(()=>matchesManagedConfigRevision(inherited),e=>e.code==='MANAGED_CONFIG_REVISION_INVALID');
 cases.push('closed options, deadline and synchronous original-operation constraints reject path override, proto authority, expired or asynchronous effects');
 let checks=0;const swapped=await database('swapped');assert.throws(()=>matchesManagedConfigRevision({...args(swapped.dataRoot),assertCurrent(){if(++checks===2){fs.renameSync(swapped.file,swapped.file+'.old');fs.copyFileSync(swapped.file+'.old',swapped.file);}}}),e=>e.code==='MANAGED_CONFIG_REVISION_CHANGED');
 cases.push('same-path existing DB replacement between held fd and effect boundary rejects before proof; no reopened path silently replaces the captured state inode');

 const origin=await database('truncated-origin'),truncatedRoot=mkdir(path.join(root,'truncated-shm'));mkdir(path.join(truncatedRoot,'state/state'));
 const truncated={dataRoot:truncatedRoot,file:path.join(truncatedRoot,'state/state/openclaw.sqlite')};
 for(const suffix of ['','-wal','-shm'])fs.copyFileSync(origin.file+suffix,truncated.file+suffix,fs.constants.COPYFILE_EXCL);
 fs.truncateSync(truncated.file+'-shm',0);const trio=[truncated.file,truncated.file+'-wal',truncated.file+'-shm'];
 const captured=trio.map(file=>({hash:hash(file),ino:fs.statSync(file).ino,size:fs.statSync(file).size}));
 assert.equal(matchesManagedConfigRevision(args(truncated.dataRoot)),true);assert.deepEqual(trio.map(file=>({hash:hash(file),ino:fs.statSync(file).ino,size:fs.statSync(file).size})),captured);
 cases.push('actual truncated original SHM stays zero bytes and unchanged; only disposable SQLite snapshot may repair its own SHM, original DB/WAL/SHM never opened by SQLite');
 const executable=path.join(root,'isolated-node');fs.copyFileSync(node,executable,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(executable,0o500);
 let execChecks=0;assert.throws(()=>matchesManagedConfigRevision({...args(good.dataRoot),interpreterPath:executable,assertCurrent(){if(++execChecks===2){fs.renameSync(executable,executable+'.original');fs.writeFileSync(executable,'#!/bin/sh\necho \'{"matches":true}\'\n',{mode:0o700});}}}),e=>e.code==='MANAGED_CONFIG_REVISION_CHANGED');
 fs.unlinkSync(executable);fs.renameSync(executable+'.original',executable);
 cases.push('fixed interpreter path swapped after initial hash rejects before spawn; alternate script cannot forge matches:true even if it could restore the original inode');
 let sourceChecks=0;const exactSource=fs.readFileSync(revisionFile);
 assert.throws(()=>matchesManagedConfigRevision({...args(good.dataRoot),assertCurrent(){if(++sourceChecks===2){fs.renameSync(revisionFile,revisionFile+'.original');fs.writeFileSync(revisionFile,exactSource);}}}),e=>e.code==='MANAGED_CONFIG_REVISION_CHANGED');
 fs.unlinkSync(revisionFile);fs.renameSync(revisionFile+'.original',revisionFile);
 cases.push('pinned revision source replaced with identical bytes/new inode after capture rejects; runtime/source directory and held fd anchors cannot silently rebind');
 let contentChecks=0;const changing=await database('changing-wal'),walSize=fs.statSync(changing.file+'-wal').size;
 try{assert.throws(()=>matchesManagedConfigRevision({...args(changing.dataRoot),assertCurrent(){contentChecks++;fs.appendFileSync(changing.file+'-wal',Buffer.alloc(4));}}),e=>e.code==='MANAGED_CONFIG_REVISION_STATE_BUSY');}finally{fs.truncateSync(changing.file+'-wal',walSize);}
 assert.ok(contentChecks>=6);cases.push('continuous original WAL churn exhausts three complete bounded snapshots and rejects; no partial source state proof accepted');
 let checkpointChecks=0;assert.equal(matchesManagedConfigRevision({...args(good.dataRoot),assertCurrent(){if(++checkpointChecks===2){const stat=fs.statSync(good.file+'-wal');fs.utimesSync(good.file+'-wal',stat.atime,new Date(stat.mtimeMs+1000));}}}),true);
 assert.ok(checkpointChecks>3);cases.push('same-inode original WAL metadata churn discards first snapshot; only a subsequent complete stable snapshot under original deadline may return HMAC proof');
 const originalTrio=[good.file,good.file+'-wal',good.file+'-shm'].map(hash),longDeadline=Date.now()+30000,longChildren=[];
 const longObserver=observedHelper((spawn,file,argv,options)=>{assert.ok(String(file).startsWith('/private/tmp/sg-managed-config-proof-'));
  assert.equal(options.timeout,10000);assert.ok(options.timeout<=longDeadline-Date.now());
  const result=spawn(file,argv,options);longChildren.push({pid:result.pid,status:result.status,signal:result.signal});return result;});
 assert.equal(longObserver({...args(good.dataRoot),deadlineAt:longDeadline}),true);assert.equal(longChildren.length,1);assert.equal(longChildren[0].status,0);assert.equal(longChildren[0].signal,null);
 assert.deepEqual([good.file,good.file+'-wal',good.file+'-shm'].map(hash),originalTrio);
 cases.push('actual fixed observer has a 10000ms child ceiling under a longer original operation; no lease extension, unchanged original DB/WAL/SHM');
 const shortStartedAt=Date.now(),shortDeadline=shortStartedAt+5000,shortChildren=[];
 const shortObserver=observedHelper((spawn,file,argv,options)=>{assert.ok(options.timeout>0&&options.timeout<5000&&options.timeout<=shortDeadline-shortStartedAt);
  const result=spawn(file,argv,options);shortChildren.push({timeoutMs:options.timeout,pid:result.pid,status:result.status,signal:result.signal});return result;});
 assert.equal(shortObserver({...args(good.dataRoot),deadlineAt:shortDeadline}),true);assert.equal(shortChildren.length,1);assert.equal(shortChildren[0].status,0);assert.equal(shortChildren[0].signal,null);
 assert.deepEqual([good.file,good.file+'-wal',good.file+'-shm'].map(hash),originalTrio);
 cases.push('actual fixed observer remains capped by the shorter original deadline rather than inheriting the 10000ms ceiling');
 const timedChildren=[];
 const timedObserver=observedHelper((spawn,file,argv,options)=>{assert.ok(argv[1].includes('SELECT hmac_key FROM config_revision_keys WHERE id = 1'));
  // Test transport only lowers the OS child budget; fixed code/interpreter,
  // original helper deadline, schema/FD fences and result object stay actual.
  const result=spawn(file,argv,{...options,timeout:1});timedChildren.push({pid:result.pid,status:result.status,signal:result.signal,code:result.error?.code});return result;});
 assert.throws(()=>timedObserver({...args(good.dataRoot),deadlineAt:Date.now()+15000}),e=>e.code==='MANAGED_CONFIG_REVISION_OBSERVER_FAILED');
 assert.equal(timedChildren.length,1);assert.equal(timedChildren[0].code,'ETIMEDOUT');assert.equal(timedChildren[0].status,null);assert.equal(timedChildren[0].signal,'SIGTERM');
 assert.deepEqual([good.file,good.file+'-wal',good.file+'-shm'].map(hash),originalTrio);
 cases.push('real fixed Node observer OS timeout (test transport budget lowered to1ms) rejects, exits via SIGTERM and is not retried; no partial HMAC proof or original DB effect, not Host acceptance');
 process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,actualPinnedNodeReadonlySqlite:true,modelRequests:0,realAccountRequests:0,globalWrites:0,boundary:'actual readonly SQLite/constraint helper on small synthetic owned DB, not Host deployment or model acceptance'})+'\n');
 }finally{const closed=await Promise.allSettled(children.map(stop));fs.rmSync(root,{recursive:true,force:true});const failed=closed.find(result=>result.status==='rejected');if(failed)throw failed.reason;}}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
