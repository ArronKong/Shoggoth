"use strict";
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const crypto=require('node:crypto');const assert=require('node:assert/strict');
const {Worker,MessageChannel}=require('node:worker_threads');
const {createManagedOpenClawHostClient}=require('../app/managed-openclaw-host-client');
const {normalizeModelChangeRequest,modelChangeRequestDigest}=require('../app/core/model-change-validation');
const {client:gatewayClient}=require('./plugin-managed-openclaw-real-host-fixture.cjs');
const repo=path.resolve(__dirname,'..');const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error(label+' timed out');}
// Transparent real Worker relay: one explicitly armed response is withheld
// AFTER the actual supervisor has paused/bound it. Never synthesizes receipts.
function workerRelay(state){return(file,{workerData})=>{
  const parent=workerData.port;const {port1,port2}=new MessageChannel();
  const actual=new Worker(file,{workerData:{...workerData,port:port2},transferList:[port2]});const commands=new Map();
  parent.on('message',frame=>{if(frame.type==='command')commands.set(frame.id,{command:frame.command,args:frame.args});try{port1.postMessage(frame);}catch{}});
  port1.on('message',frame=>{const command=frame.type==='response'?commands.get(frame.id):null;
    if(command){commands.delete(frame.id);if(command.command==='modelAcquire'&&command.args.operationId===state.operationId&&frame.ok){
      if(state.armed&&!command.args.recovery){state.armed=false;state.dropped=true;state.binding=frame.result.binding;return;}
      if(command.args.recovery&&state.binding)state.recoverySameBinding=['token','operationId','requestDigest','generation','writerNonce'].every(k=>frame.result.binding[k]===state.binding[k]);
    }}try{parent.postMessage(frame);}catch{}});
  const terminate=actual.terminate.bind(actual);actual.terminate=async()=>{parent.close();port1.close();return terminate();};return actual;
};}
async function main(){
  const root=fs.realpathSync(process.argv[2]);assert.ok(root.startsWith('/private/tmp/sg-managed-openclaw-'));
  const sourceNames=['app/managed-openclaw-config-source-ledger.js','app/managed-openclaw-config-revision.js','app/managed-openclaw-model-policy.js','app/managed-openclaw-host-client.js','app/managed-openclaw-host-worker.js','app/managed-openclaw-host-supervisor.js',
    'app/managed-plugin-host-runtime.js','app/managed-openclaw-runtime-pins.json','app/core/model-change-validation.js',
    'resources/external-plugin-adapters/openclaw/transport.mjs','resources/external-plugin-adapters/openclaw/index.mjs',
    'resources/external-plugin-adapters/openclaw/openclaw.plugin.json','resources/external-plugin-adapters/openclaw/package.json',
    'app/core/device-auth.js','scripts/plugin-managed-openclaw-real-host-fixture.cjs','scripts/plugin-managed-openclaw-model-real-host-fixture.cjs',
    'resources/external-plugin-host-patches/openclaw/2026.9.5-managed-v2/openclaw-2026.9.5-managed.json',
    'resources/external-plugin-host-patches/openclaw/2026.9.5-managed-v2/shoggoth-managed-runtime.mjs'];
  const readSourceHashes=()=>Object.fromEntries(sourceNames.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,name))).digest('hex')]));
  const sourceHashes=readSourceHashes();
  const supervisorStateDir=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-managed-model-host-'));fs.chmodSync(supervisorStateDir,0o700);
  const serviceUserDataRoot=path.join(supervisorStateDir,'service');fs.mkdirSync(serviceUserDataRoot,{mode:0o700});
  const calls=[];const model=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const parsed=JSON.parse(body);calls.push({model:parsed.model});res.writeHead(200,{'content-type':'text/event-stream'});
    for(const[delta,finish_reason]of[[{role:'assistant',content:'Private model lease result.'},null],[{},'stop']])
      res.write(`data: ${JSON.stringify({id:'lease-local',object:'chat.completion.chunk',created:1,model:parsed.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    res.end('data: [DONE]\n\n');});});await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const configuration={models:{mode:'replace',providers:{probe:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture-only',api:'openai-completions',agentRuntime:{id:'openclaw'},
    models:[{id:'lease-local',name:'Original Local',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]}}},
    agents:{defaults:{model:{primary:'probe/lease-local'},heartbeat:{every:'0m'}}},tools:{profile:'minimal'}};
  const lostReceipt={operationId:'model-recovery',armed:false,dropped:false,recoverySameBinding:false};
  const worker=createManagedOpenClawHostClient({stateDir:path.join(root,'app-state'),supervisorStateDir,serviceUserDataRoot,
    resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters'),
    sourceRoot:'/opt/homebrew/lib/node_modules/openclaw',interpreterPath:(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')),architecture:'arm64',gatewayConfiguration:configuration,workerFactory:workerRelay(lostReceipt)});
  const groups=[];const physical=[];const catalogueProofs=[];let passed=false;const progress=[];let socket=null;let closeTriggered=null;let lease=null;
  worker.onProgress(value=>progress.push(value));
  const rememberChild=()=>{const value=worker.getStatus().identity;if(value&&!physical.some(x=>x.pid===value.pid&&x.nonce===value.nonce))physical.push(value);};
  const rememberCatalog=(phase,catalog)=>catalogueProofs.push({phase,models:(catalog.models||[]).map(({id,provider,name,contextWindow,reasoning})=>({id,provider,name,contextWindow,reasoning}))});
  try{
    await worker.ready;assert.equal(await worker.modelApi.isModelApplySupported(),false);
    const candidate=await worker.controller.getCandidate({});assert.ok(candidate);
    await worker.controller.activateCandidate({candidateId:candidate.candidateId,operationId:'model-baseline'});
    assert.equal(await worker.modelApi.isModelApplySupported(),true);physical.push(worker.getEndpoint().identity);
    socket=await gatewayClient(worker.getEndpoint().url,worker.getEndpoint().token);
    groups.push('actual fixed candidate and authenticated managed Gateway confirm reload-off model transaction support; absent host reports unsupported');
    const safeSpec=normalizeModelChangeRequest({providerKey:'probe',sourceModelId:'lease-local',model:{id:'lease-local',name:'Applied Private',contextWindow:64000}}).safeSpec;
    const identity={operationId:'model-apply',requestDigest:modelChangeRequestDigest(safeSpec)};
    lease=await worker.modelApi.acquireModelLease({...identity,safeSpec,recovery:false});
    assert.equal(worker.getEndpoint(),null);assert.equal(worker.getExecution(),null);assert.ok(lease.expiresAt>Date.now());
    assert.equal(await worker.modelApi.assertModelLease(lease,identity),true);
    await assert.rejects(worker.modelApi.assertModelLease({...lease},identity),e=>e.code==='MANAGED_MODEL_LEASE_UNTRUSTED');
    await assert.rejects(socket.request('chat.send',{sessionKey:'agent:main:model-paused',message:'must not run',idempotencyKey:crypto.randomUUID()}));
    assert.equal(calls.length,0);assert.equal(await lease.assertIdle(),true);
    groups.push('branded op/digest lease pauses actual Host before effects; cached endpoint/execution and already connected ordinary model admission are closed with zero model requests');
    await assert.rejects(async()=>lease.modelRpc('chat.send',{}),e=>e.code==='MANAGED_MODEL_RPC_UNSUPPORTED');
    await assert.rejects(async()=>lease.modelRpc('references.lease.acquire',{}),e=>e.code==='MANAGED_MODEL_RPC_UNSUPPORTED');
    assert.deepEqual(await lease.getModelReferenceCapabilities(),{});
    const original=await lease.modelRpc('config.get',{});assert.equal(original.parsed.gateway.reload.mode,'off');
    const protectedPatch={gateway:{auth:{token:'forged'}}};
    await assert.rejects(lease.modelRpc('config.patch',{raw:JSON.stringify(protectedPatch),baseHash:original.hash,replacePaths:[]}),e=>e.code==='MANAGED_MODEL_OWNED_CONFIG_CHANGED');
    await assert.rejects(lease.modelRpc('config.patch',{raw:'{}',baseHash:'a'.repeat(64),replacePaths:[]}),e=>e.code==='MANAGED_MODEL_CONFIG_CONFLICT');
    groups.push('model RPC allowlist and owner-file CAS reject control/model bypass, unverified reference write, owned credentials and stale config; no ordinary Gateway config.patch call');
    const models=structuredClone(original.parsed.models.providers.probe.models);models[0]={...models[0],...safeSpec.model};
    const patch={models:{providers:{probe:{models}}}};
    await lease.modelRpc('config.patch',{raw:JSON.stringify(patch),baseHash:original.hash,replacePaths:['models.providers.probe.models']});
    const stored=await lease.modelRpc('config.get',{});assert.deepEqual(stored.parsed.gateway,original.parsed.gateway);assert.deepEqual(stored.parsed.plugins,original.parsed.plugins);
    assert.equal(stored.parsed.models.providers.probe.apiKey,original.parsed.models.providers.probe.apiKey);
    assert.equal(original.managedConfigSource.loaded,true);assert.equal(stored.managedConfigSource.loaded,false);
    assert.equal(stored.managedConfigSource.loadedRawHash,original.hash);assert.equal(stored.managedConfigSource.persistedRawHash,stored.hash);
    await assert.rejects(lease.verifyTarget(safeSpec),e=>e.code==='MANAGED_MODEL_RESTART_REQUIRED');
    const renewed=await lease.renew();assert.ok(renewed.expiresAt>Date.now());
    assert.equal(calls.length,0);groups.push('bound model fields write atomically while system-owned config and private provider credential remain unchanged; target cannot pass before real restart');
    assert.equal(await lease.restartPaused(),true);assert.equal(worker.getEndpoint(),null);assert.equal(worker.getExecution(),null);
    assert.equal(await lease.waitHealthy(),true);assert.equal(await lease.verifyTarget(safeSpec),true);
    const newlyLoaded=await lease.modelRpc('config.get',{});assert.equal(newlyLoaded.managedConfigSource.loaded,true);
    assert.equal(newlyLoaded.managedConfigSource.loadedRawHash,newlyLoaded.hash);
    physical.push(worker.getStatus().identity);assert.notEqual(physical[0].pid,physical[1].pid);assert.throws(()=>process.kill(physical[0].pid,0));
    const prepared=await lease.modelRpc('models.list',{});assert.ok(prepared.models.some(row=>row.id==='probe/lease-local'||row.provider==='probe'&&row.id==='lease-local'));
    rememberCatalog('applied-prepared',prepared);assert.equal(calls.length,0);groups.push('exact old child exit precedes new fence/nonce/generation; same fixed candidate restarts paused and actual models.list proves prepared target with zero model requests');
    const finish=await lease.finish({...identity,safeSpec,outcome:'applied'});assert.deepEqual(finish,{paused:false,resumed:true,healthVerified:true});
    assert.ok(worker.getEndpoint());assert.ok(worker.getExecution());await assert.rejects(worker.modelApi.assertModelLease(lease,identity),e=>e.code==='MANAGED_MODEL_LEASE_UNTRUSTED');
    socket.close();socket=await gatewayClient(worker.getEndpoint().url,worker.getEndpoint().token);
    await socket.request('chat.send',{sessionKey:'agent:main:model-after-apply',message:'prove actual model after resume',idempotencyKey:crypto.randomUUID()});
    await until(()=>calls.length===1,'post-apply model');await until(async()=>JSON.stringify(await worker.request('chat.history',{sessionKey:'agent:main:model-after-apply',limit:20})).includes('Private model lease result.'),'persisted post-apply result');
    groups.push('verified applied finish alone resumes real Gateway and publishes exact new endpoint; ordinary model then executes once and persists actual result');
    const compensationSpec=normalizeModelChangeRequest({providerKey:'probe',sourceModelId:'lease-local',model:{id:'lease-local',name:'Temporary Private',contextWindow:65536}}).safeSpec;
    const compensationIdentity={operationId:'model-compensation',requestDigest:modelChangeRequestDigest(compensationSpec)};
    const compensation=await worker.modelApi.acquireModelLease({...compensationIdentity,safeSpec:compensationSpec});const saved=await compensation.modelRpc('config.get',{});
    const temporary=structuredClone(saved.parsed.models.providers.probe.models);temporary[0]={...temporary[0],...compensationSpec.model};
    await compensation.modelRpc('config.patch',{raw:JSON.stringify({models:{providers:{probe:{models:temporary}}}}),baseHash:saved.hash,replacePaths:['models.providers.probe.models']});
    await compensation.restartPaused();rememberChild();assert.equal(await compensation.verifyTarget(compensationSpec),true);
    rememberCatalog('temporary-prepared',await compensation.modelRpc('models.list',{}));
    const beforeRestore=await compensation.modelRpc('config.get',{});
    await compensation.modelRpc('config.patch',{raw:JSON.stringify({models:saved.parsed.models,agents:saved.parsed.agents}),baseHash:beforeRestore.hash,replacePaths:['models.providers.probe.models']});
    assert.deepEqual(await compensation.finish({...compensationIdentity,safeSpec:compensationSpec,outcome:'compensated'}),{paused:false,resumed:true,healthVerified:true});rememberChild();
    assert.equal(calls.length,1);groups.push('real temporary target is prepared paused; exact original private models/agents compensation triggers a confirmed old-child exit and verified restored runtime before resume');
    const blockedIdentity={operationId:'model-no-write-blocked',requestDigest:identity.requestDigest};const blocked=await worker.modelApi.acquireModelLease({...blockedIdentity,safeSpec});
    const restored=await blocked.modelRpc('config.get',{});assert.equal(restored.parsed.models.providers.probe.models[0].name,'Applied Private');
    rememberCatalog('compensated-restored',await blocked.modelRpc('models.list',{}));
    assert.deepEqual(await blocked.finish({...blockedIdentity,safeSpec,outcome:'blocked'}),{paused:false,resumed:true,healthVerified:true});assert.equal(calls.length,1);
    groups.push('blocked outcome with zero config writes resumes only after actual restored catalogue/health/idle proof; no additional model request');
    const createSpec=normalizeModelChangeRequest({providerKey:'probe',model:{id:'retire-fixture',name:'Retire Fixture',contextWindow:32000}}).safeSpec;
    const createIdentity={operationId:'model-create-retire-fixture',requestDigest:modelChangeRequestDigest(createSpec)};
    const created=await worker.modelApi.acquireModelLease({...createIdentity,safeSpec:createSpec});const createBefore=await created.modelRpc('config.get',{});
    const createRows=[...createBefore.parsed.models.providers.probe.models,{...createSpec.model,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}];
    await created.modelRpc('config.patch',{raw:JSON.stringify({models:{providers:{probe:{models:createRows}}}}),baseHash:createBefore.hash,replacePaths:['models.providers.probe.models']});
    await created.restartPaused();rememberChild();assert.equal(await created.verifyTarget(createSpec),true);
    assert.deepEqual(await created.finish({...createIdentity,safeSpec:createSpec,outcome:'applied'}),{paused:false,resumed:true,healthVerified:true});
    const deleteSpec={kind:'delete-model',providerKey:'probe',sourceModelId:'retire-fixture',sourceKey:JSON.stringify(['probe','retire-fixture']),target:null};
    const deleteIdentity={operationId:'model-delete-fixture',requestDigest:modelChangeRequestDigest(deleteSpec)};
    const retired=await worker.modelApi.acquireModelLease({...deleteIdentity,safeSpec:deleteSpec});const deleteBefore=await retired.modelRpc('config.get',{});
    await retired.modelRpc('config.patch',{raw:JSON.stringify({models:{providers:{probe:{models:deleteBefore.parsed.models.providers.probe.models.filter(row=>row.id!=='retire-fixture')}}}}),baseHash:deleteBefore.hash,replacePaths:['models.providers.probe.models']});
    assert.equal(await retired.convergeAfterRetire(deleteSpec),true);rememberChild();const retiredCatalog=await retired.modelRpc('models.list',{});
    assert.ok(!retiredCatalog.models.some(row=>row.id==='retire-fixture'||row.id==='probe/retire-fixture'));rememberCatalog('deleted-converged',retiredCatalog);
    assert.deepEqual(await retired.finish({...deleteIdentity,safeSpec:deleteSpec,outcome:'applied'}),{paused:false,resumed:true,healthVerified:true});assert.equal(calls.length,1);
    groups.push('created fixture model actually prepares; delete converge uses same fixed candidate paused restart and real catalogue absence before verified finish, without calling a model');
    socket.close();socket=await gatewayClient(worker.getEndpoint().url,worker.getEndpoint().token);
    const originalRecoverySpec=normalizeModelChangeRequest({providerKey:'unreconstructable',providerMode:'new',baseUrl:configuration.models.providers.probe.baseUrl,model:{id:'missing'}}).safeSpec;
    const recoveryIdentity={operationId:'model-recovery',requestDigest:modelChangeRequestDigest(originalRecoverySpec)};
    const missingAckAbort=new AbortController();lostReceipt.armed=true;
    const missingAck=worker.modelApi.acquireModelLease({...recoveryIdentity,safeSpec:originalRecoverySpec,recovery:false,signal:missingAckAbort.signal});
    const missingRejected=assert.rejects(missingAck,e=>e.code==='MANAGED_WORKER_OPERATION_RETIRED');await until(()=>lostReceipt.dropped,'actual acquire receipt withheld');missingAckAbort.abort();await missingRejected;
    assert.equal(worker.getEndpoint(),null);assert.equal(worker.getExecution(),null);
    await assert.rejects(socket.request('chat.send',{sessionKey:'agent:main:unknown-acquire',message:'must stay paused after lost receipt',idempotencyKey:crypto.randomUUID()}));assert.equal(calls.length,1);
    groups.push('transparent real Worker port drops original acquire ACK only after Host pauses; original Main hold and ordinary admission remain closed with no model resend');
    const recoverySpec={kind:originalRecoverySpec.kind,providerKey:originalRecoverySpec.providerKey,providerMode:originalRecoverySpec.providerMode,sourceModelId:originalRecoverySpec.sourceModelId,model:originalRecoverySpec.model};
    for(const changed of [{...recoveryIdentity,operationId:'forged-recovery'},{...recoveryIdentity,requestDigest:'d'.repeat(64)}])
      await assert.rejects(worker.modelApi.acquireModelLease({...changed,safeSpec:recoverySpec,recovery:true}),e=>e.code==='MANAGED_MODEL_IDENTITY_INVALID');
    const recovery=await worker.modelApi.acquireModelLease({...recoveryIdentity,safeSpec:recoverySpec,recovery:true});
    assert.equal(lostReceipt.recoverySameBinding,true);
    const recoveryConfig=await recovery.modelRpc('config.get',{});
    await assert.rejects(recovery.modelRpc('config.patch',{raw:'{}',baseHash:recoveryConfig.hash,replacePaths:[]}),e=>e.code==='MANAGED_MODEL_RECOVERY_WRITE_UNSUPPORTED');
    await assert.rejects(recovery.verifyTarget(recoverySpec),e=>e.code==='MANAGED_MODEL_TARGET_UNVERIFIED');
    await recovery.abandon({reason:'missing_original_endpoint'});assert.equal(worker.getEndpoint(),null);assert.equal(worker.getExecution(),null);
    await assert.rejects(worker.controller.activateCandidate({candidateId:candidate.candidateId,operationId:'bypass-abandoned'}),e=>e.code==='MANAGED_MODEL_UNAVAILABLE');
    assert.equal(calls.length,1);socket.close();socket=null;
    await worker.controller.stopOwned({operationId:'model-stop-abandoned',timeoutMs:30000});assert.equal(worker.getStatus().ownership,'absent');
    groups.push('original uncertain op/digest recover the same real held token/nonce/generation; new op/digest reject, omitted endpoint permits read only and no reconstruction/write; unknown target keeps pause until exact owned stop');
    await worker.controller.activateCandidate({candidateId:candidate.candidateId,operationId:'model-cancel-baseline'});physical.push(worker.getEndpoint().identity);
    const cancelIdentity={operationId:'model-close-restart',requestDigest:identity.requestDigest};
    const closing=await worker.modelApi.acquireModelLease({...cancelIdentity,safeSpec,recovery:false});
    let closingPhase=false;worker.onProgress(value=>{if(closingPhase&&value.operationState==='modelAction'&&!closeTriggered)
      closeTriggered=worker.close({operationId:'model-fixture-close',timeoutMs:30000});});
    closingPhase=true;const restart=closing.restartPaused();await assert.rejects(restart,e=>e.code==='MANAGED_WORKER_OPERATION_RETIRED');
    assert.ok(closeTriggered);await closeTriggered;assert.equal(worker.getStatus().state,'closed');
    assert.equal(fs.existsSync(path.join(supervisorStateDir,'external-plugin-host-data/openclaw/v1/writer.fence')),false);
    for(const child of physical)assert.throws(()=>process.kill(child.pid,0));assert.equal(calls.length,1);
    groups.push('close cancels an actual paused restart before late spawn/resume, retires token and uses original pause operation for owned exit/fence cleanup; no further model request');
    assert.ok(progress.every(value=>!JSON.stringify(value).includes(supervisorStateDir)&&!Object.hasOwn(value,'endpoint')&&!Object.hasOwn(value,'token')));
    const evidence={version:1,status:'PASS',groups,candidateId:candidate.candidateId,runtimeTreeSha256:candidate.runtimeTreeSha256,physicalChildren:physical,
      modelRequests:calls.length,modelRequestIds:calls.map(x=>x.model),catalogueProofs,unknownAcquireAck:{operationId:recoveryIdentity.operationId,requestDigest:recoveryIdentity.requestDigest,actualReceiptWithheld:true,sameOriginalBindingOnRecovery:lostReceipt.recoverySameBinding,originalGeneration:lostReceipt.binding.generation,originalWriterNonce:lostReceipt.binding.writerNonce},additionalSourceCopies:0,globalWrites:0,realAccountRequests:0,
      sourceHashes};
    assert.deepEqual(readSourceHashes(),sourceHashes,'owned source changed during actual proof');
    const evidenceFile=path.join(root,'model-lease-public-evidence.json');fs.writeFileSync(evidenceFile,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
    passed=true;process.stdout.write(JSON.stringify({status:'PASS',groups:groups.length,modelRequests:calls.length,evidence:evidenceFile})+'\n');
  }catch(error){fs.writeFileSync(path.join(root,'model-lease-failure.json'),JSON.stringify({status:'FAIL',code:error.code||null,message:error.message,groups,physicalChildren:physical,modelRequests:calls.length,supervisorStateDir,progress},null,2)+'\n',{mode:0o600});throw error;}finally{socket?.close();if(worker.getStatus().state!=='closed')try{await worker.close({operationId:'model-fixture-cleanup',timeoutMs:30000});}catch(error){process.stderr.write('owned model cleanup pending: '+error.code+'\n');}
    model.closeAllConnections();await new Promise(resolve=>model.close(resolve));if(passed&&worker.getStatus().state==='closed')fs.rmSync(supervisorStateDir,{recursive:true,force:true});}
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
