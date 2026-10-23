"use strict";
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {EventEmitter}=require('node:events');
const {createManagedOpenClawHostClient}=require('../app/managed-openclaw-host-client');
const {normalizeModelChangeRequest,modelChangeRequestDigest}=require('../app/core/model-change-validation');
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-model-client-unit-'));fs.chmodSync(root,0o700);const repo=path.resolve(__dirname,'..');
const safeSpec=normalizeModelChangeRequest({providerKey:'probe',sourceModelId:'local',model:{id:'local',name:'Test'}}).safeSpec;
const identity={operationId:'model-op',requestDigest:modelChangeRequestDigest(safeSpec)};
const options=name=>({stateDir:path.join(root,name),resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters'),
  sourceRoot:'/opt/homebrew/lib/node_modules/openclaw',interpreterPath:(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')),architecture:'arm64',gatewayConfiguration:{},serviceUserDataRoot:root});
function factory(mode,record){return(_file,{workerData:{port,channelId,init}})=>{
  const worker=new EventEmitter();record.port=port;record.frames=[];record.worker=worker;record.terminations=0;
  worker.terminate=async()=>{record.terminations+=1;port.close();worker.emit('exit',0);};
  const binding={token:'a'.repeat(64),...identity,generation:'fixture-generation',writerNonce:'b'.repeat(64)};
  const snap=paused=>({status:{backendId:'openclaw',state:paused?'paused':'absent',ownership:paused?'managed':'absent',dataRoot:path.join(init.stateDir,'data'),
    identity:paused?{pid:12345,startIdentity:'synthetic test boundary only',nonce:binding.writerNonce}:null,runtimeRoot:paused?'/private/tmp/fixed-fixture':null,
    candidateId:paused?'c'.repeat(64):null,generation:paused?binding.generation:null,selectionSupported:paused,adapterGeneration:paused?'adapter-generation':null,
    adapterInstanceId:paused?'adapter-instance':null,counts:paused?{totalActive:0}:null,operationId:paused?identity.operationId:null},endpoint:null,execution:null,observedAt:Date.now()});
  let paused=false;
  port.on('message',frame=>{record.frames.push(frame);if(frame.type==='cancel')return;
    let result=null;const expiresAt=Date.now()+120000;
    if(frame.command==='modelAcquire'){paused=true;if(mode==='lost-acquire'&&!frame.args.recovery)return;result={binding:{...binding},expiresAt:mode==='expired'?Date.now()-1:expiresAt,value:true};}
    if(frame.command==='modelAction'){
      const {action}=frame.args;if(mode==='pending'&&action==='restart')return;
      const value=action==='renew'?{expiresAt}:action==='capabilities'?{}:action==='abandon'?{paused:true,resumed:false}:action==='finish'?{paused:false,resumed:true,healthVerified:true}:true;
      result={binding:{...binding,...(mode==='wrong-binding'?{operationId:'other-operation'}:{})},expiresAt,value};
    }
    if(frame.command==='stopOwned'){paused=false;result={ownership:'absent'};}
    if(frame.command==='observe')result=snap(paused).status;
    port.postMessage({type:'response',channelId,id:frame.id,ok:true,result,error:null,snapshot:snap(paused)});
  });queueMicrotask(()=>port.postMessage({type:'ready',channelId,snapshot:snap(false)}));return worker;};}
async function main(){const cases=[];const cleanup=[];try{
  const record={};const client=createManagedOpenClawHostClient({...options('brand'),workerFactory:factory('valid',record)});cleanup.push(client);await client.ready;
  const before=record.frames.length;await assert.rejects(client.modelApi.acquireModelLease({...identity,requestDigest:'f'.repeat(64),safeSpec}),e=>e.code==='MANAGED_MODEL_DIGEST_MISMATCH');
  assert.equal(record.frames.length,before);const lease=await client.modelApi.acquireModelLease({...identity,safeSpec});assert.ok(lease.expiresAt>Date.now());
  await assert.rejects(client.modelApi.assertModelLease({...lease},identity),e=>e.code==='MANAGED_MODEL_LEASE_UNTRUSTED');
  await assert.rejects(client.modelApi.assertModelLease(lease,{...identity,operationId:'different'}),e=>e.code==='MANAGED_MODEL_IDENTITY_INVALID');
  assert.equal(await client.modelApi.assertModelLease(lease,identity),true);assert.equal(await lease.assertIdle(),true);
  const renew=await lease.renew();assert.equal(lease.expiresAt,renew.expiresAt);assert.equal(client.getEndpoint(),null);assert.equal(client.getExecution(),null);
  cases.push('private receipt mints only original WeakMap lease; clone/different operation/forged spec digest fail before effects; renew tracks true future deadline and paused caches stay null');
  await assert.rejects(async()=>lease.modelRpc('gateway.shoggoth.managed.resume',{}),e=>e.code==='MANAGED_MODEL_RPC_UNSUPPORTED');
  await assert.rejects(lease.finish({...identity,safeSpec,outcome:'applied'}),e=>e.code==='MANAGED_MODEL_RESUME_UNVERIFIED');
  assert.equal(client.getEndpoint(),null);cases.push('model RPC cannot forward Gateway control; success-shaped finish without actual running snapshot cannot publish endpoint');
  await client.close({operationId:'brand-close',timeoutMs:1000});assert.equal(record.terminations,1);assert.equal(client.getStatus().ownership,'absent');
  for(const mode of ['expired','wrong-binding']){
    const r={};const c=createManagedOpenClawHostClient({...options(mode),workerFactory:factory(mode,r)});cleanup.push(c);await c.ready;
    if(mode==='expired')await assert.rejects(c.modelApi.acquireModelLease({...identity,safeSpec}),e=>e.code==='MANAGED_MODEL_RECEIPT_INVALID');
    else{const l=await c.modelApi.acquireModelLease({...identity,safeSpec});await assert.rejects(l.assertIdle(),e=>e.code==='MANAGED_MODEL_RECEIPT_INVALID');}
    assert.equal(c.getEndpoint(),null);await c.close({operationId:mode+'-close',timeoutMs:1000});
  }cases.push('expired receipt and mismatched bound operation cannot authorize lease effects or ordinary readiness');
  const pendingRecord={};const pending=createManagedOpenClawHostClient({...options('pending'),workerFactory:factory('pending',pendingRecord)});cleanup.push(pending);await pending.ready;
  const l=await pending.modelApi.acquireModelLease({...identity,safeSpec});const restart=l.restartPaused();const rejected=assert.rejects(restart,e=>e.code==='MANAGED_WORKER_OPERATION_RETIRED');
  await new Promise(resolve=>setTimeout(resolve,5));await pending.close({operationId:'pending-close',timeoutMs:1000});await rejected;
  const ci=pendingRecord.frames.findIndex(f=>f.type==='cancel');const si=pendingRecord.frames.findIndex(f=>f.command==='stopOwned');assert.ok(ci>=0&&si>ci);
  await assert.rejects(pending.modelApi.assertModelLease(l,identity),e=>e.code==='MANAGED_MODEL_LEASE_UNTRUSTED');
  cases.push('close retires local model brand and cancels pending restart before owned stop; no late continuation receives authority');
  const abortRecord={};const abortClient=createManagedOpenClawHostClient({...options('abort'),workerFactory:factory('pending',abortRecord)});cleanup.push(abortClient);await abortClient.ready;
  const abort=new AbortController();const canceledLease=await abortClient.modelApi.acquireModelLease({...identity,safeSpec,signal:abort.signal});
  const running=canceledLease.restartPaused();const canceled=assert.rejects(running,e=>e.code==='MANAGED_WORKER_OPERATION_RETIRED');await new Promise(resolve=>setTimeout(resolve,5));abort.abort();await canceled;
  await assert.rejects(canceledLease.assertIdle(),e=>e.code==='MANAGED_MODEL_LEASE_UNTRUSTED');await canceledLease.abandon({reason:'provider_lease_canceled'});
  assert.equal(abortClient.getEndpoint(),null);await abortClient.close({operationId:'abort-close',timeoutMs:1000});
  cases.push('provider signal cancellation cancels active command, denies further effects and still permits private paused abandonment/owned cleanup');
  const lostRecord={};const lost=createManagedOpenClawHostClient({...options('lost'),workerFactory:factory('lost-acquire',lostRecord)});cleanup.push(lost);await lost.ready;
  const recoveryView={kind:safeSpec.kind,providerKey:safeSpec.providerKey,sourceModelId:safeSpec.sourceModelId,model:safeSpec.model};
  const noHold=lostRecord.frames.length;
  await assert.rejects(lost.modelApi.acquireModelLease({...identity,safeSpec:recoveryView,recovery:true}),e=>e.code==='MANAGED_MODEL_RECOVERY_OWNER_UNAVAILABLE');
  assert.equal(lostRecord.frames.length,noHold);
  const lostAbort=new AbortController();const missing=lost.modelApi.acquireModelLease({...identity,safeSpec,signal:lostAbort.signal});
  const missingRejected=assert.rejects(missing,e=>e.code==='MANAGED_WORKER_OPERATION_RETIRED');await new Promise(resolve=>setTimeout(resolve,5));lostAbort.abort();await missingRejected;
  assert.equal(lost.getEndpoint(),null);assert.equal(lost.getExecution(),null);const heldFrames=lostRecord.frames.length;
  for(const changed of [{...identity,operationId:'new-op'},{...identity,requestDigest:'e'.repeat(64)}])
    await assert.rejects(lost.modelApi.acquireModelLease({...changed,safeSpec:recoveryView,recovery:true}),e=>e.code==='MANAGED_MODEL_IDENTITY_INVALID');
  assert.equal(lostRecord.frames.length,heldFrames);
  const recovered=await lost.modelApi.acquireModelLease({...identity,safeSpec:recoveryView,recovery:true});
  assert.equal(await lost.modelApi.assertModelLease(recovered,identity),true);assert.equal(lost.getEndpoint(),null);
  const normalAcquire=lostRecord.frames.find(f=>f.command==='modelAcquire'&&!f.args.recovery);
  const recoveredAcquire=lostRecord.frames.find(f=>f.command==='modelAcquire'&&f.args.recovery);
  assert.equal(normalAcquire.args.operationId,recoveredAcquire.args.operationId);assert.equal(normalAcquire.args.requestDigest,recoveredAcquire.args.requestDigest);
  await recovered.abandon({reason:'original_ack_missing'});assert.equal(lost.getEndpoint(),null);await lost.close({operationId:'lost-close',timeoutMs:1000});
  cases.push('unknown acquire ACK keeps original Main hold; fresh recovery without hold and new op/digest fail before wire; exact original op recovery receives paused brand without model/config resend');
  process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,boundary:'synthetic private-port schema/brand only; not Host deployment proof'})+'\n');
}finally{for(const c of cleanup)if(c.getStatus().state!=='closed')try{await c.close({timeoutMs:1000});}catch{}fs.rmSync(root,{recursive:true,force:true});}}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
