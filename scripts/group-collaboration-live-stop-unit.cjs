#!/usr/bin/env node
"use strict";
// Focused process-lifecycle regression only: synthetic OWN Node children,
// no Source services, Runtime/SDK/Auth readers, account files or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events'),{spawn,fork}=require('node:child_process');
const external=require('./group-collaboration-live-external.cjs');
const root=fs.mkdtempSync('/private/tmp/sggroup-owned-stop-unit-');fs.chmodSync(root,0o700);
const env={HOME:root,CODEX_HOME:path.join(root,'.codex'),TMPDIR:root,PATH:path.dirname(process.execPath),LANG:'C'};
const children=[],evidence=[],tests=[];
const test=(name,run)=>tests.push({name,run});
const registry={getBackend:()=>null};
function watch(child){children.push(child);const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));return{child,closed};}
async function spawned(child){await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}
test('actual OWN child exit before close waits for close and PID absence',async()=>{
 const {child,closed}=watch(spawn(process.execPath,['-e',"process.stdin.once('data',()=>process.exit(0))"],{cwd:root,env,stdio:['pipe','pipe','pipe']}));await spawned(child);
 const records=external.captureOwnedProcesses({registry,ownedProcesses:[child]});assert.equal(records[0].before.availability,'present');
 const verifying=new Promise((resolve,reject)=>child.once('exit',()=>{
  try{assert.equal(records[0].exitObserved,true);assert.equal(records[0].closeObserved,false);external.verifyOwnedProcessesStopped(records,{timeoutMs:2000}).then(resolve,reject);}catch(error){reject(error);}
 }));child.stdin.end('owned-exit');const proof=await verifying;await closed;
 assert.equal(proof.stopped,true);assert.equal(proof.processEvidence[0].closeObserved,true);assert.equal(proof.processEvidence[0].after.availability,'absent');assert.equal(proof.processEvidence[0].exitCode,0);
 evidence.push({case:'real-exit-before-close',closeAtVerifyEntry:false,proof});
});
function fake(){const proc=new EventEmitter();Object.assign(proc,{pid:12345,exitCode:null,signalCode:null});return proc;}
const identity={availability:'present',pid:12345,parentPid:2,processGroupId:2,startedAt:'synthetic',commandDigest:'a'.repeat(64)};
test('missing close times out closed and removes listeners without fabricating close',async()=>{
 const proc=fake(),records=external.captureOwnedProcesses({registry,ownedProcesses:[proc],identify:()=>identity});proc.exitCode=0;proc.emit('exit',0);
 const proof=await external.verifyOwnedProcessesStopped(records,{identify:()=>({availability:'absent',pid:proc.pid}),timeoutMs:1});
 assert.equal(proof.stopped,false);assert.equal(proof.processEvidence[0].exitObserved,true);assert.equal(proof.processEvidence[0].closeObserved,false);assert.equal(proc.listenerCount('exit'),0);assert.equal(proc.listenerCount('close'),0);
 proc.emit('close',0);assert.equal(proof.processEvidence[0].closeObserved,false);evidence.push({case:'missing-close-timeout',proof});
});
test('late capture cannot infer a previously unobserved close from exitCode',async()=>{
 const proc=fake();proc.exitCode=0;proc.emit('exit',0);proc.emit('close',0);
 const records=external.captureOwnedProcesses({registry,ownedProcesses:[proc],identify:()=>identity});const proof=await external.verifyOwnedProcessesStopped(records,{identify:()=>({availability:'absent',pid:proc.pid}),timeoutMs:1});
 assert.equal(proof.stopped,false);assert.equal(proof.processEvidence[0].closeObserved,false);evidence.push({case:'late-capture-unknown-close',proof});
});
const fixture=path.join(root,'actor.cjs');fs.writeFileSync(fixture,`"use strict";
const mode=process.argv[2];
function finish(){process.send({type:'stopped',value:{stopped:mode!=='inner-failed'}},()=>process.exit(0));}
process.on('message',m=>{if(m&&m.type==='stop-owned-bridge')finish();});
process.send({type:'ready'},()=>{if(mode==='already-exited')finish();});
`,{flag:'wx',mode:0o600});
async function actor(mode){
 const {child,closed}=watch(fork(fixture,[mode],{cwd:root,env,execArgv:[],stdio:['ignore','ignore','ignore','ipc']}));
 const records=external.captureOwnedProcesses({registry,ownedNativeProcesses:[{proc:child,kind:'owned-external-bridge-actor',detached:false}]});let inner=null;
 const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m?.type==='stopped')inner=m.value;if(m?.type==='ready')resolve();});child.once('error',reject);});
 await ready;assert.equal(records[0].before.availability,'present');if(mode==='already-exited')await closed;
 const proof=await external.stopOwnedActor(child,records,{getStopEvidence:()=>inner,timeoutMs:2000});await closed;return proof;
}
test('actual fork actor has independent close/PID proof and keeps inner IPC proof',async()=>{
 const proof=await actor('normal');assert.equal(proof.stopped,true);assert.equal(proof.childExited,true);assert.equal(proof.childClosed,true);assert.equal(proof.childExitCode,0);assert.equal(proof.runtimeStopEvidence.stopped,true);
 assert.equal(proof.actorStopEvidence.processEvidence.length,1);assert.equal(proof.actorStopEvidence.processEvidence[0].kind,'owned-external-bridge-actor');assert.equal(proof.actorStopEvidence.processEvidence[0].after.availability,'absent');evidence.push({case:'actual-fork-actor-normal',proof});
});
test('closed actor cannot hide failed inner proof and already-exited actor retains observed close',async()=>{
 const failed=await actor('inner-failed');assert.equal(failed.stopped,false);assert.equal(failed.childClosed,true);assert.equal(failed.runtimeStopEvidence.stopped,false);
 const exited=await actor('already-exited');assert.equal(exited.stopped,true);assert.equal(exited.childClosed,true);evidence.push({case:'actor-failed-inner-and-already-exited',failed,exited});
});
async function main(){
 let passed=0;
 try{for(const {name,run}of tests){await run();passed++;process.stdout.write('PASS '+name+'\n');}
  const report={version:1,status:'passed',tests:tests.length,pass:passed,fail:0,evidence,SourceServices:0,SDKAuthCalls:0,OriginalAccountBodyReads:0,modelCalls:0};
  const file=process.argv[2];if(file){if(!path.isAbsolute(file)||!file.startsWith('/private/tmp/'))throw Error('OWN_TEST_EVIDENCE_PATH');const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o400);try{fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  process.stdout.write('group-collaboration-live-stop-unit: '+passed+'/'+tests.length+' passed; SDK/Auth/Model calls 0\n');
 }finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  await Promise.all(children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>{child.once('close',resolve);setTimeout(resolve,2000).unref();})));
  fs.rmSync(root,{recursive:true,force:true});
 }
}
main().catch(error=>{process.stderr.write((error.stack||error.message)+'\n');process.exitCode=1;});
