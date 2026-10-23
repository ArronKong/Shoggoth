"use strict";
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {createManagedOpenClawHostClient,_protocol:p}=require('../app/managed-openclaw-host-client');
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-managed-worker-unit-'));fs.chmodSync(root,0o700);
const repo=path.resolve(__dirname,'..');const options=name=>({stateDir:path.join(root,name),resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),
  adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters'),sourceRoot:'/opt/homebrew/lib/node_modules/openclaw',
  interpreterPath:(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')),architecture:'arm64',gatewayConfiguration:{},serviceUserDataRoot:root});
const makeSnapshot=stateDir=>({status:{backendId:'openclaw',state:'absent',ownership:'absent',dataRoot:path.join(stateDir,'external-plugin-host-data/openclaw/v1'),
  identity:null,runtimeRoot:null,candidateId:null,generation:null,selectionSupported:false,adapterGeneration:null,adapterInstanceId:null,counts:null,operationId:null},
  endpoint:null,execution:null,observedAt:Date.now()});
function fakeFactory(mode,record){return(_file,workerOptions)=>{const worker=new EventEmitter();const {port,channelId,init}=workerOptions.workerData;
  record.worker=worker;record.port=port;record.channelId=channelId;record.frames=[];
  record.terminations=0;worker.terminate=async()=>{record.terminations+=1;port.close();worker.emit('exit',0);return 0;};
  port.on('message',frame=>{record.frames.push(frame);if(frame.type==='cancel')return;
    if(mode==='timeout'&&frame.command!=='stopOwned')return;
    if(mode==='blocked-close'&&frame.command!=='stopOwned')return;
    if(mode==='never-close'&&!record.allowStop)return;
    if(mode==='malformed'){port.postMessage({type:'response',channelId,id:frame.id,ok:true,result:null,error:null,snapshot:{ready:true}});return;}
    const result=frame.command==='stopOwned'?{ownership:'absent'}:null;
    port.postMessage({type:'response',channelId,id:frame.id,ok:true,result,error:null,snapshot:makeSnapshot(init.stateDir)});
  });
  queueMicrotask(()=>port.postMessage(mode==='ready-json'?{type:'ready',channelId,snapshot:{ready:true}}:
    {type:'ready',channelId,snapshot:makeSnapshot(init.stateDir)}));return worker;};}
async function main(){const cases=[];const cleanup=[];try{
  const bad=options('bad');Object.setPrototypeOf(bad,{authority:{ready:true}});
  assert.throws(()=>createManagedOpenClawHostClient(bad),e=>e.code==='MANAGED_WORKER_INIT_INVALID');
  assert.throws(()=>createManagedOpenClawHostClient({...options('extra'),inputPins:{ready:true}}),e=>e.code==='MANAGED_WORKER_INIT_INVALID');
  const accessor=options('getter');Object.defineProperty(accessor,'gatewayConfiguration',{enumerable:true,get(){throw Error('getter executed');}});
  assert.throws(()=>createManagedOpenClawHostClient(accessor),e=>e.code==='MANAGED_WORKER_INIT_INVALID');
  assert.throws(()=>p.argsFor('prepareCandidate',{sourceRoot:'/elsewhere'}),e=>e.code==='MANAGED_WORKER_COMMAND_INVALID');
  assert.throws(()=>p.argsFor('prepareCandidate',{supervisorStateDir:'/elsewhere'}),e=>e.code==='MANAGED_WORKER_COMMAND_INVALID');
  assert.throws(()=>p.argsFor('getCandidate',{candidateId:'a'.repeat(64)}),e=>e.code==='MANAGED_WORKER_COMMAND_INVALID');
  assert.throws(()=>p.argsFor('activateCandidate',{candidateId:'a'.repeat(64),operationId:'op',authority:{ready:true}}),e=>e.code==='MANAGED_WORKER_COMMAND_INVALID');
  assert.throws(()=>p.requestParams('chat.send',{message:'model bypass'}),e=>e.code==='MANAGED_WORKER_METHOD_UNSUPPORTED');
  assert.throws(()=>p.requestParams('gateway.shoggoth.managed.resume',{operationId:'op',controlToken:'a'.repeat(64)}),e=>e.code==='MANAGED_WORKER_PARAMS_INVALID');
  cases.push('prototypes/accessors/extra fields/caller paths, policy, authority and arbitrary model RPC are rejected before worker dispatch');
  const record={};const client=createManagedOpenClawHostClient({...options('fake-timeout'),workerFactory:fakeFactory('timeout',record),commandTimeoutMs:50});cleanup.push(record);
  const notifications=[];client.onProgress(value=>notifications.push(value));await client.ready;
  await assert.rejects(client.controller.observe({}),e=>e.code==='MANAGED_WORKER_COMMAND_TIMEOUT');
  await new Promise(resolve=>setTimeout(resolve,10));
  const canceled=record.frames.find(f=>f.type==='cancel');assert.ok(canceled);
  record.port.postMessage({type:'snapshot',channelId:record.channelId,snapshot:makeSnapshot(options('fake-timeout').stateDir)});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(client.getEndpoint(),null);assert.equal(client.getExecution(),null);
  assert.equal(client.getStatus().state,'needs_verification');
  assert.ok(notifications.every(v=>!JSON.stringify(v).includes(root)&&!Object.hasOwn(v,'endpoint')&&!Object.hasOwn(v,'token')));
  await assert.rejects(client.controller.activateCandidate({candidateId:'a'.repeat(64),operationId:'after-timeout'}),e=>e.code==='MANAGED_WORKER_UNAVAILABLE');
  await client.close({operationId:'cleanup',timeoutMs:1000});cases.push('command timeout cancels private operation, clears all ready caches, ignores late snapshots, preserves stop-only cleanup and emits scrubbed progress');
  for(const kind of ['prepareCandidate','activateCandidate']){
    const closeRecord={};const closing=createManagedOpenClawHostClient({...options('close-'+kind),workerFactory:fakeFactory('blocked-close',closeRecord)});cleanup.push(closeRecord);
    await closing.ready;const args=kind==='prepareCandidate'?{}:{candidateId:'a'.repeat(64),operationId:'pending-activation'};
    const mutation=closing.controller[kind](args);const retired=assert.rejects(mutation,e=>e.code==='MANAGED_WORKER_OPERATION_RETIRED');
    await new Promise(resolve=>setTimeout(resolve,5));const before=Date.now();const close=closing.close({operationId:'close-pending',timeoutMs:1000});
    assert.equal(closing.getEndpoint(),null);assert.equal(closing.getExecution(),null);
    await close;await retired;const cancelIndex=closeRecord.frames.findIndex(frame=>frame.type==='cancel');
    const stopIndex=closeRecord.frames.findIndex(frame=>frame.command==='stopOwned');assert.ok(cancelIndex>=0&&stopIndex>cancelIndex);
    assert.ok(closeRecord.frames[stopIndex].deadlineAt<=before+1000+10);assert.equal(closeRecord.terminations,1);
    assert.equal(closing.getStatus().state,'closed');
  }
  cases.push('close during pending prepare or activate cancels first, clears caches immediately, bounds queued owned stop to the original close deadline, and terminates only after absent');
  const stalledRecord={};const stalled=createManagedOpenClawHostClient({...options('close-stalled'),workerFactory:fakeFactory('never-close',stalledRecord)});cleanup.push(stalledRecord);
  await stalled.ready;const old=stalled.controller.prepareCandidate({});const oldRejected=assert.rejects(old,e=>e.code==='MANAGED_WORKER_OPERATION_RETIRED');
  await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(stalled.close({operationId:'bounded-close',timeoutMs:50}),e=>e.code==='MANAGED_WORKER_CLOSE_NEEDS_VERIFICATION');
  await oldRejected;assert.equal(stalled.getStatus().state,'needs_verification');assert.equal(stalledRecord.terminations,0);
  const stopFrame=stalledRecord.frames.find(frame=>frame.command==='stopOwned');
  stalledRecord.port.postMessage({type:'response',channelId:stalledRecord.channelId,id:stopFrame.id,ok:true,result:{ownership:'absent'},error:null,snapshot:makeSnapshot(options('close-stalled').stateDir)});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stalledRecord.terminations,0);assert.equal(stalled.getEndpoint(),null);
  await assert.rejects(stalled.controller.activateCandidate({candidateId:'a'.repeat(64),operationId:'late'}),e=>e.code==='MANAGED_WORKER_UNAVAILABLE');
  stalledRecord.allowStop=true;await stalled.close({operationId:'different-retry-intent',timeoutMs:1000});
  const stops=stalledRecord.frames.filter(frame=>frame.command==='stopOwned');assert.equal(stops.length,2);
  assert.equal(stops[0].args.operationId,'bounded-close');assert.equal(stops[1].args.operationId,'bounded-close');
  assert.equal(stalledRecord.terminations,1);assert.equal(stalled.getStatus().state,'closed');
  cases.push('close timeout retains Worker ownership and rejects late readiness; explicit retry uses the original cleanup operation and terminates only after later absent proof');
  const malformedRecord={};const malformed=createManagedOpenClawHostClient({...options('fake-malformed'),workerFactory:fakeFactory('malformed',malformedRecord)});cleanup.push(malformedRecord);
  await malformed.ready;await assert.rejects(malformed.controller.observe({}),e=>e.code==='MANAGED_WORKER_SNAPSHOT_INVALID');
  assert.equal(malformed.getEndpoint(),null);assert.equal(malformed.getStatus().state,'needs_verification');
  await malformedRecord.worker.terminate();cases.push('malformed private response rejects its pending caller and clears state rather than leaving a promise or old URL');
  const readyRecord={};const ready=createManagedOpenClawHostClient({...options('fake-ready'),workerFactory:fakeFactory('ready-json',readyRecord)});cleanup.push(readyRecord);
  await assert.rejects(ready.ready,e=>e.code==='MANAGED_WORKER_SNAPSHOT_INVALID');assert.equal(ready.getEndpoint(),null);await readyRecord.worker.terminate();
  cases.push('serializable ready JSON cannot promote a worker or host endpoint');
  const deadRecord={};const dead=createManagedOpenClawHostClient({...options('fake-exit'),workerFactory:fakeFactory('normal',deadRecord)});cleanup.push(deadRecord);
  await dead.ready;deadRecord.worker.emit('error',Error('worker failed'));assert.equal(dead.getStatus().state,'needs_verification');assert.equal(dead.getExecution(),null);
  await assert.rejects(dead.controller.prepareCandidate({}),e=>e.code==='MANAGED_WORKER_UNAVAILABLE');await deadRecord.worker.terminate();
  cases.push('worker error is terminal for startup and never creates an automatic replacement worker');
  const separatedOptions=options('separate-manager');const privateHost=path.join(root,'separate-host');fs.mkdirSync(separatedOptions.stateDir,{mode:0o700});fs.mkdirSync(privateHost,{mode:0o700});
  const separated=createManagedOpenClawHostClient({...separatedOptions,supervisorStateDir:privateHost});await separated.ready;
  assert.equal(separated.getStatus().dataRoot,path.join(privateHost,'external-plugin-host-data/openclaw/v1'));assert.equal(await separated.controller.getCandidate({}),null);
  await separated.close({operationId:'separate-close',timeoutMs:1000});
  for(const variant of ['symlink','permissions','source-overlap']){
    const o=options('bad-host-'+variant);fs.mkdirSync(o.stateDir,{mode:0o700});const host=path.join(root,'unsafe-host-'+variant);
    if(variant==='symlink')fs.symlinkSync(privateHost,host);else if(variant==='permissions'){fs.mkdirSync(host,{mode:0o700});fs.chmodSync(host,0o755);}
    const badHost=createManagedOpenClawHostClient({...o,supervisorStateDir:variant==='source-overlap'?o.sourceRoot:host});
    await assert.rejects(badHost.ready,e=>e.code==='MANAGED_WORKER_FAILED');assert.equal(badHost.getEndpoint(),null);
  }
  cases.push('trusted manager/host roots may separate with real private-directory checks; command paths, symlink/unsafe permissions/source overlap cannot override or adopt a writer');
  const realOptions=options('actual');fs.mkdirSync(realOptions.stateDir,{mode:0o700});const actual=createManagedOpenClawHostClient(realOptions);
  assert.equal(Object.isFrozen(actual),true);assert.equal(Object.isFrozen(actual.controller),true);assert.equal(Object.isFrozen(actual.modelApi),true);
  assert.equal(Object.isFrozen(actual.ready),false);const {AsyncLocalStorage}=require('node:async_hooks'),als=new AsyncLocalStorage();
  const inherited=await als.run({operation:'real-private-worker-als'},async()=>{await actual.ready;return actual.modelApi.isModelApplySupported();});
  assert.equal(inherited,false);als.disable();
  cases.push('actual Client ready Promise retains native async-hooks mutability while public APIs remain frozen; real Worker model-supported query safely crosses newly enabled AsyncLocalStorage with no Host');
  await actual.ready;assert.equal(actual.getStatus().ownership,'absent');assert.equal(actual.getEndpoint(),null);assert.equal(actual.getExecution(),null);
  assert.equal(await actual.controller.getCandidate({}),null);assert.equal(await actual.controller.getActive({}),null);
  const observed=await actual.controller.observe({});assert.equal(observed.ownership,'absent');
  const recovered=await actual.controller.recover({});assert.equal(recovered.adoptionSupported,false);assert.equal(recovered.active,null);
  await actual.close({operationId:'actual-close',timeoutMs:1000});assert.equal(actual.getStatus().state,'closed');
  cases.push('actual node Worker returns genuine absent manager/supervisor state; read-only recovery never fabricates adoption and owned close terminates only after absent proof');
  process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,hostStarts:0,globalWrites:0})+'\n');
}finally{for(const item of cleanup)try{item.port?.close();}catch{}fs.rmSync(root,{recursive:true,force:true});}}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
