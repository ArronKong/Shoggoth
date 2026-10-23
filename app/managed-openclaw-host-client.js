"use strict";
// Trusted App-main API. Never expose this object or its private MessagePort to
// renderer IPC; only scrubbed onProgress metadata is suitable for forwarding.
const path=require("node:path");const crypto=require("node:crypto");const fs=require("node:fs");
const {Worker,MessageChannel}=require("node:worker_threads");
const HASH=/^[a-f0-9]{64}$/;const OP=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTH=new WeakSet();
const modelPolicy=require("./managed-openclaw-model-policy");
const credentialPolicy=require("./managed-openclaw-provider-credential");
const credentialSchema=require("./managed-openclaw-provider-credential-schema");
const failure=code=>Object.assign(new Error(code),{code});
function plain(value){return value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).every(key=>{
  const d=Object.getOwnPropertyDescriptor(value,key);return typeof key==="string"&&d.enumerable&&Object.hasOwn(d,"value")&&!['__proto__','constructor','prototype'].includes(key);
});}
function exact(value,keys){return plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
function data(value,depth=0){if(depth>24)throw failure("MANAGED_WORKER_DATA_INVALID");
  if(value===null||typeof value==="boolean"||typeof value==="string"&&Buffer.byteLength(value)<=1024*1024||typeof value==="number"&&Number.isFinite(value))return;
  if(Array.isArray(value)){if(value.length>10000)throw failure("MANAGED_WORKER_DATA_INVALID");for(const item of value)data(item,depth+1);return;}
  if(!plain(value)||Reflect.ownKeys(value).length>10000)throw failure("MANAGED_WORKER_DATA_INVALID");for(const item of Object.values(value))data(item,depth+1);
}
function clone(value){data(value);return JSON.parse(JSON.stringify(value));}
// Freeze public data containers, not native promises: Node async_hooks adds
// its private async-id when an existing ready Promise first enters ALS.
function freeze(value){if(value&&typeof value==="object"&&(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
const REQUEST_METHODS=Object.freeze(new Set(['health','models.list','agents.list','chat.history','chat.selection.capabilities','chat.selection.get',
  'gateway.shoggoth.managed.status','gateway.shoggoth.managed.pause','gateway.shoggoth.managed.resume','gateway.shoggoth.managed.retire']));
function requestParams(method,params){if(!REQUEST_METHODS.has(method)||!plain(params))throw failure("MANAGED_WORKER_METHOD_UNSUPPORTED");
  const keys=method.startsWith('gateway.shoggoth.managed.')?['operationId']:
    method==='chat.history'?['sessionKey','limit']:method==='chat.selection.capabilities'?['sessionKey','agentId']:method==='chat.selection.get'?['operationId']:[];
  if(Object.keys(params).some(key=>!keys.includes(key)))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  if(method.startsWith('gateway.shoggoth.managed.')&&(!exact(params,['operationId'])||!OP.test(params.operationId)))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  for(const key of ['sessionKey','agentId','operationId'])if(Object.hasOwn(params,key)&&(!OP.test(params[key])||params[key].length>128))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  if(Object.hasOwn(params,'limit')&&(!Number.isSafeInteger(params.limit)||params.limit<1||params.limit>500))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  if(method==='chat.history'&&!Object.hasOwn(params,'sessionKey')||method==='chat.selection.capabilities'&&!Object.hasOwn(params,'sessionKey')
    ||method==='chat.selection.get'&&!Object.hasOwn(params,'operationId'))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  data(params);return true;
}
function argsFor(command,args){if(!plain(args))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  const keysets={inspectSource:[],prepareCandidate:[],getActive:[],observe:[],getCandidate:[],activateCandidate:['candidateId','operationId'],
    stopOwned:['operationId','timeoutMs'],request:['method','params','timeoutMs'],recover:[],modelSupported:[],
    modelAcquire:['operationId','requestDigest','recovery','safeSpec','undefinedKeys'],modelAction:['binding','action','params'],modelTerminalRecover:['binding']};
  const keys=keysets[command];if(!keys||!exact(args,keys))throw failure("MANAGED_WORKER_COMMAND_INVALID");
  if(Object.hasOwn(args,'candidateId')&&!HASH.test(args.candidateId)||Object.hasOwn(args,'operationId')&&!OP.test(args.operationId))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  if(Object.hasOwn(args,'timeoutMs')&&(!Number.isSafeInteger(args.timeoutMs)||args.timeoutMs<25||args.timeoutMs>60000))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  if(command==='request')requestParams(args.method,args.params);
  if(command==='modelAcquire'){
    if(!HASH.test(args.requestDigest)||typeof args.recovery!=='boolean')throw failure('MANAGED_MODEL_IDENTITY_INVALID');
    modelPolicy.digestMatches(modelPolicy.restoreSpec(args.safeSpec,args.undefinedKeys,args.recovery),args.requestDigest,args.recovery);
  }
  if(command==='modelAction'||command==='modelTerminalRecover'){
    const b=args.binding;if(!exact(b,['token','operationId','requestDigest','generation','writerNonce'])||!HASH.test(b.token)||!OP.test(b.operationId)
      ||!HASH.test(b.requestDigest)||!OP.test(b.generation)||!HASH.test(b.writerNonce))throw failure('MANAGED_MODEL_IDENTITY_INVALID');
    if(command==='modelTerminalRecover'){data(args);return true;}
    const ak={assert:[],credentialOwner:[],credentialBind:['permit'],capabilities:[],idle:[],renew:[],restart:[],healthy:[],rpc:['method','params'],verify:['safeSpec'],converge:['safeSpec'],
      finish:['outcome','safeSpec'],abandon:['reason']};
    if(!ak[args.action]||!(exact(args.params,ak[args.action])||args.action==='rpc'&&exact(args.params,['method','params','credentialPhase'])))throw failure('MANAGED_MODEL_ACTION_INVALID');
    if(args.action==='rpc'){
      modelPolicy.modelParams(args.params.method,args.params.params);
      if(Object.hasOwn(args.params,'credentialPhase'))credentialSchema.credentialRpcOptions(args.params.method,{credentialPhase:args.params.credentialPhase});
    }
    if(args.action==='credentialBind'){
      const permit=credentialSchema.credentialPermit(args.params.permit);
      if(permit.scope.operationId!==b.operationId||permit.scope.requestDigest!==b.requestDigest
        ||permit.writer.nonce!==b.writerNonce||permit.writer.generation!==b.generation)throw failure('MANAGED_MODEL_CREDENTIAL_OWNER_INVALID');
    }
    if(args.action==='finish'&&!['applied','compensated','blocked'].includes(args.params.outcome))throw failure('MANAGED_MODEL_OUTCOME_UNVERIFIED');
    if(args.action==='abandon'&&(typeof args.params.reason!=='string'||args.params.reason.length>256||!args.params.reason))throw failure('MANAGED_MODEL_ACTION_INVALID');
  }
  data(args);return true;
}
function serviceRootFor(value){
  if(typeof value!=='string'||Buffer.byteLength(value)>4096||!path.isAbsolute(value)||path.normalize(value)!==value)
    throw failure('MANAGED_OPENCLAW_SERVICE_ROOT_INVALID');
  let stat;try{stat=fs.lstatSync(value);}catch{throw failure('MANAGED_OPENCLAW_SERVICE_ROOT_INVALID');}
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid()||fs.realpathSync(value)!==value)
    throw failure('MANAGED_OPENCLAW_SERVICE_ROOT_INVALID');
  return value;
}
function initFor(options){const keys=['stateDir','resourcesRoot','adapterResourcesRoot','sourceRoot','interpreterPath','architecture'];
  if(!keys.every(key=>typeof options[key]==='string')||!keys.slice(0,5).every(key=>path.isAbsolute(options[key]))
    ||!['arm64','x64'].includes(options.architecture))throw failure("MANAGED_WORKER_INIT_INVALID");
  const supervisorStateDir=options.supervisorStateDir===undefined?options.stateDir:options.supervisorStateDir;
  if(typeof supervisorStateDir!=='string'||!path.isAbsolute(supervisorStateDir))throw failure('MANAGED_WORKER_INIT_INVALID');
  const gatewayConfiguration=clone(options.gatewayConfiguration||{});
  if(!plain(gatewayConfiguration)||Object.keys(gatewayConfiguration).some(key=>!['models','agents','tools'].includes(key)))throw failure("MANAGED_WORKER_INIT_INVALID");
  return {...Object.fromEntries(keys.map(key=>[key,options[key]])),supervisorStateDir,gatewayConfiguration,serviceUserDataRoot:serviceRootFor(options.serviceUserDataRoot)};
}
function validateSnapshot(value){if(!exact(value,['status','endpoint','execution','observedAt'])||!Number.isSafeInteger(value.observedAt)||value.observedAt<=0)
  throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");data(value);
  const status=value.status;
  if(!exact(status,['backendId','state','ownership','dataRoot','identity','runtimeRoot','candidateId','generation','selectionSupported','adapterGeneration','adapterInstanceId','counts','operationId'])
    ||status.backendId!=='openclaw'||!['absent','managed','unknown'].includes(status.ownership)||typeof status.state!=='string'
    ||typeof status.dataRoot!=='string'||!path.isAbsolute(status.dataRoot)||typeof status.selectionSupported!=='boolean')throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");
  if(status.identity!==null&&(!exact(status.identity,['pid','startIdentity','nonce'])||!Number.isSafeInteger(status.identity.pid)||status.identity.pid<=1
    ||typeof status.identity.startIdentity!=='string'||!status.identity.startIdentity||status.identity.startIdentity.length>256||!HASH.test(status.identity.nonce)))throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");
  if(value.endpoint!==null){const e=value.endpoint;
    if(status.ownership!=='managed'||status.state!=='running'||status.selectionSupported!==true||![status.generation,status.adapterGeneration,status.adapterInstanceId].every(id=>OP.test(id))
      ||!exact(e,['url','token','identity','dataRoot','runtimeRoot','interpreterPath','entryPath'])||typeof e.url!=='string'||!/^ws:\/\/127\.0\.0\.1:\d+$/.test(e.url)
      ||!HASH.test(e.token)||!plain(e.identity)||e.identity.pid!==status.identity?.pid||e.identity.nonce!==status.identity?.nonce
      ||e.identity.startIdentity!==status.identity?.startIdentity||e.dataRoot!==status.dataRoot||e.runtimeRoot!==status.runtimeRoot
      ||!exact(value.execution,['runtimeRoot','interpreterPath','entryPath','home','stateDir','configPath','workspace','env'])||value.execution.runtimeRoot!==e.runtimeRoot
      ||value.execution.interpreterPath!==e.interpreterPath||value.execution.entryPath!==e.entryPath)throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");
  }else if(value.execution!==null)throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");
  return freeze(clone(value));
}
function createManagedOpenClawHostClient(options={}){
  if(!plain(options)||Object.keys(options).some(key=>!['stateDir','supervisorStateDir','resourcesRoot','adapterResourcesRoot','sourceRoot','interpreterPath','architecture','gatewayConfiguration','serviceUserDataRoot','workerFactory','commandTimeoutMs'].includes(key)))
    throw failure("MANAGED_WORKER_INIT_INVALID");
  const init=initFor(options);const channelId=crypto.randomBytes(32).toString('hex');const {port1,port2}=new MessageChannel();
  const factory=options.workerFactory||((file,workerOptions)=>new Worker(file,workerOptions));if(typeof factory!=='function')throw failure("MANAGED_WORKER_INIT_INVALID");
  if(options.commandTimeoutMs!==undefined&&(!Number.isSafeInteger(options.commandTimeoutMs)||options.commandTimeoutMs<25||options.commandTimeoutMs>600000))throw failure("MANAGED_WORKER_TIMEOUT_INVALID");
  let worker,closed=false,closing=false,closePromise=null,cleanupOperationId=null,modelHold=null,lastCredentialFinish=null,poisoned=false,cache=null,sequence=0;const pending=new Map();const listeners=new Set();const leases=new WeakMap();const records=new Set();
  let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  // Avoid an unhandled rejection when a composition root observes ready later.
  ready.catch(()=>{});
  const safeStatus=()=>cache?{backendId:'openclaw',state:cache.status.state,ownership:cache.status.ownership,
    selectionSupported:cache.status.selectionSupported===true,observedAt:cache.observedAt}:
    {backendId:'openclaw',state:closed?'closed':poisoned?'needs_verification':closing?'stopping':'starting',ownership:closed?'absent':'unknown',selectionSupported:false,observedAt:null};
  const notify=()=>{const value=freeze(safeStatus());for(const callback of listeners)try{callback(value);}catch{}};
  const cancelPending=code=>{const error=failure(code);for(const [id,item]of pending){
    try{port1.postMessage({type:'cancel',channelId,id});}catch{}clearTimeout(item.timer);item.signal?.removeEventListener("abort",item.cancel);item.reject(error);}pending.clear();};
  const clear=(code)=>{for(const r of records)r.retired=true;clearTimeout(readyTimer);poisoned=true;cache=null;notify();readyReject(failure(code));cancelPending(code);};
  const invalidate=()=>{cache=null;notify();};
  port1.on('message',frame=>{
    try{
      if(!plain(frame)||frame.channelId!==channelId)throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
      if(frame.type==='ready'){
        if(!exact(frame,['type','channelId','snapshot'])||poisoned||closed)throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
        const snapshot=validateSnapshot(frame.snapshot);if(!closing)cache=snapshot;clearTimeout(readyTimer);notify();readyResolve(safeStatus());return;
      }
      if(frame.type==='progress'){
        if(!exact(frame,['type','channelId','state'])||typeof frame.state!=='string'||frame.state.length>64)throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
        for(const callback of listeners)try{callback(freeze({...safeStatus(),operationState:frame.state}));}catch{}return;
      }
      if(frame.type==='snapshot'){
        if(!exact(frame,['type','channelId','snapshot']))throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
        if(!poisoned&&!closed&&!closing){cache=validateSnapshot(frame.snapshot);notify();}return;
      }
      if(frame.type!=='response'||!exact(frame,['type','channelId','id','ok','result','error','snapshot']))throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
      const item=pending.get(frame.id);if(!item)return;
      if(typeof frame.ok!=='boolean')throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
      const snapshot=validateSnapshot(frame.snapshot);let result;
      if(frame.ok)result=freeze(clone(frame.result));
      else if(!exact(frame.error,['code'])||typeof frame.error.code!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(frame.error.code))throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
      if(item.terminalRecord&&frame.ok){terminalReceipt(result,snapshot,item.terminalRecord);poisoned=false;}
      pending.delete(frame.id);clearTimeout(item.timer);item.signal?.removeEventListener("abort",item.cancel);
      if(item.modelRecovery&&frame.ok&&modelHold&&snapshot.status.state==='paused'&&snapshot.endpoint===null
        &&snapshot.status.operationId===modelHold.operationId&&result?.binding?.operationId===modelHold.operationId
        &&result?.binding?.requestDigest===modelHold.requestDigest&&result?.binding?.generation===snapshot.status.generation
        &&result?.binding?.writerNonce===snapshot.status.identity?.nonce)poisoned=false;
      if(!poisoned&&!closed&&!closing){cache=snapshot;notify();}
      if(frame.ok)item.resolve(result);else item.reject(failure(frame.error.code));
    }catch(error){clear(error.code||"MANAGED_WORKER_PROTOCOL_INVALID");}
  });
  port1.on('messageerror',()=>clear("MANAGED_WORKER_MESSAGE_INVALID"));port1.on('close',()=>{if(!closed)clear("MANAGED_WORKER_DISCONNECTED");});
  const readyTimer=setTimeout(()=>clear("MANAGED_WORKER_READY_TIMEOUT"),15000);
  try{worker=factory(path.join(__dirname,'managed-openclaw-host-worker.js'),{workerData:{version:1,channelId,init,port:port2},transferList:[port2]});}
  catch(error){clearTimeout(readyTimer);port1.close();port2.close();clear("MANAGED_WORKER_START_FAILED");throw error;}
  worker.on('error',()=>{clearTimeout(readyTimer);clear("MANAGED_WORKER_FAILED");});
  worker.on('exit',()=>{clearTimeout(readyTimer);if(!closed)clear("MANAGED_WORKER_EXITED");});
  const timeouts={inspectSource:120000,prepareCandidate:600000,activateCandidate:180000,getCandidate:120000,getActive:120000,observe:15000,recover:15000,stopOwned:60000,request:60000,modelSupported:15000,modelAcquire:60000,modelAction:180000,modelTerminalRecover:90000};
  async function command(kind,args={},cleanupDeadlineAt=null,signal=null){
    argsFor(kind,args);signal?.throwIfAborted();const recoveryAllowed=()=>!closing&&modelHold&&(kind==='modelSupported'
      ||kind==='modelAcquire'&&args.recovery===true&&args.operationId===modelHold.operationId&&args.requestDigest===modelHold.requestDigest
      ||kind==='modelTerminalRecover'&&lastCredentialFinish&&args.binding.operationId===modelHold.operationId
        &&args.binding.requestDigest===modelHold.requestDigest&&modelPolicy.equal(args.binding,lastCredentialFinish.finishBinding));
    if(closed||(poisoned||closing)&&!['stopOwned','observe','recover'].includes(kind)&&!recoveryAllowed())throw failure("MANAGED_WORKER_UNAVAILABLE");
    await ready;if(closed||(poisoned||closing)&&!['stopOwned','observe','recover'].includes(kind)&&!recoveryAllowed())throw failure("MANAGED_WORKER_UNAVAILABLE");
    const timeoutMs=cleanupDeadlineAt===null?(kind==='stopOwned'||kind==='request'?args.timeoutMs+1000:options.commandTimeoutMs||timeouts[kind]):cleanupDeadlineAt-Date.now();
    if(timeoutMs<=0)throw failure("MANAGED_WORKER_CLOSE_NEEDS_VERIFICATION");
    signal?.throwIfAborted();const id=`host-${++sequence}`;if(['activateCandidate','stopOwned','modelAcquire','modelTerminalRecover'].includes(kind))invalidate();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);try{port1.postMessage({type:'cancel',channelId,id});}catch{}
        signal?.removeEventListener("abort",cancel);clear("MANAGED_WORKER_COMMAND_TIMEOUT");reject(failure("MANAGED_WORKER_COMMAND_TIMEOUT"));},timeoutMs);
      const cancel=()=>{if(!pending.delete(id))return;clearTimeout(timer);try{port1.postMessage({type:'cancel',channelId,id});}catch{}
        signal?.removeEventListener('abort',cancel);invalidate();reject(failure('MANAGED_WORKER_OPERATION_RETIRED'));};
      pending.set(id,{resolve,reject,timer,command:kind,signal,cancel,modelRecovery:kind==='modelAcquire'&&args.recovery===true,terminalRecord:kind==='modelTerminalRecover'?lastCredentialFinish:null});signal?.addEventListener('abort',cancel,{once:true});
      try{port1.postMessage({type:'command',channelId,id,command:kind,args:clone(args),deadlineAt:Date.now()+timeoutMs});}
      catch{pending.delete(id);clearTimeout(timer);signal?.removeEventListener("abort",cancel);clear("MANAGED_WORKER_DISCONNECTED");reject(failure("MANAGED_WORKER_DISCONNECTED"));}
    });
  }
  const controller=freeze({inspectSource:(args={})=>command('inspectSource',args),prepareCandidate:(args={})=>command('prepareCandidate',args),
    activateCandidate:args=>command('activateCandidate',args),getCandidate:args=>command('getCandidate',args),getActive:(args={})=>command('getActive',args),
    observe:(args={})=>command('observe',args),recover:(args={})=>command('recover',args),
    stopOwned:async({operationId=`stop-${crypto.randomUUID()}`,timeoutMs=15000}={})=>{retireModels();const result=await command('stopOwned',{operationId,timeoutMs});if(result.ownership==='absent'){modelHold=null;lastCredentialFinish=null;}return result;},
    request:({method,params={},timeoutMs=15000}={})=>{if(modelHold)throw failure('MANAGED_MODEL_UNAVAILABLE');return command('request',{method,params,timeoutMs});}});
  function retireModels(){for(const r of records)r.retired=true;
    for(const[id,item]of pending)if(['modelAcquire','modelAction','modelTerminalRecover'].includes(item.command)){
      pending.delete(id);clearTimeout(item.timer);item.signal?.removeEventListener('abort',item.cancel);
      try{port1.postMessage({type:'cancel',channelId,id});}catch{}item.reject(failure('MANAGED_WORKER_OPERATION_RETIRED'));}
    invalidate();}
  function terminalReceipt(result,snapshot,record){
    if(!record?.credentialBound||!record.finishBinding||!exact(result,['binding','expiresAt','value'])
      ||!modelPolicy.equal(result.binding,record.finishBinding)||result.expiresAt!==record.finishExpiresAt||result.expiresAt<=Date.now()
      ||!exact(result.value,['outcome','paused','resumed','healthVerified'])||result.value.outcome!==record.finishOutcome
      ||result.value.paused!==false||result.value.resumed!==true||result.value.healthVerified!==true
      ||snapshot.status.state!=='running'||snapshot.status.ownership!=='managed'||snapshot.status.operationId!==null
      ||!snapshot.endpoint||!modelPolicy.equal(snapshot.status.identity,record.finishIdentity)
      ||snapshot.status.generation!==record.finishBinding.generation||snapshot.status.runtimeRoot!==record.finishRuntimeRoot
      ||snapshot.status.dataRoot!==record.finishDataRoot||snapshot.status.counts?.totalActive!==0)
      throw failure('MANAGED_MODEL_TERMINAL_RECEIPT_INVALID');
    return result;
  }
  function responseFor(result,record){
    if(!exact(result,['binding','expiresAt','value'])||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=Date.now()||result.expiresAt>Date.now()+300000)
      throw failure('MANAGED_MODEL_RECEIPT_INVALID');
    argsFor('modelAction',{binding:result.binding,action:'assert',params:{}});
    if(record&&(result.binding.token!==record.binding.token||result.binding.operationId!==record.binding.operationId
      ||result.binding.requestDigest!==record.binding.requestDigest))throw failure('MANAGED_MODEL_RECEIPT_INVALID');
    if(record){record.binding=result.binding;record.expiresAt=result.expiresAt;}return result;
  }
  function recordFor(lease,identity=null){const r=leases.get(lease);
    if(!r||r.retired||r.expiresAt<=Date.now()||poisoned||closed||closing||r.signal?.aborted)throw failure('MANAGED_MODEL_LEASE_UNTRUSTED');
    if(identity){modelPolicy.identity(identity);if(identity.operationId!==r.binding.operationId||identity.requestDigest!==r.binding.requestDigest)throw failure('MANAGED_MODEL_IDENTITY_INVALID');}return r;}
  function invoke(record,action,params={}){
    const captured=clone(params);
    const job=async()=>{
      if(action!=='abandon')recordFor(record.lease);
      if(action==='finish'&&record.credentialBound){
        if(record.finishOutcome)throw failure('MANAGED_MODEL_TERMINAL_RECOVERY_REQUIRED');
        record.finishOutcome=captured.outcome;record.finishBinding=clone(record.binding);record.finishExpiresAt=record.expiresAt;
        record.finishIdentity=clone(cache.status.identity);record.finishRuntimeRoot=cache.status.runtimeRoot;record.finishDataRoot=cache.status.dataRoot;
        lastCredentialFinish=record;
      }
      const result=responseFor(await command('modelAction',{binding:record.binding,action,params:captured},null,action==='abandon'?null:record.signal),record);
      if(action==='finish'){
        if(!exact(result.value,['paused','resumed','healthVerified'])||result.value.paused!==false||result.value.resumed!==true||result.value.healthVerified!==true
          ||cache?.status.state!=='running'||!cache?.endpoint)throw failure('MANAGED_MODEL_RESUME_UNVERIFIED');
        record.retired=true;records.delete(record);modelHold=null;
      }else if(action==='abandon'){record.retired=true;invalidate();}
      if(action==='credentialOwner'){
        const owner=credentialPolicy.credentialOwner(result.value);
        if(owner.operationId!==record.binding.operationId||owner.requestDigest!==record.binding.requestDigest
          ||owner.nonce!==record.binding.writerNonce||owner.generation!==record.binding.generation
          ||owner.pid!==cache?.status.identity?.pid||owner.startIdentity!==cache?.status.identity?.startIdentity
          ||owner.runtimeRoot!==cache?.status.runtimeRoot||owner.dataRoot!==cache?.status.dataRoot
          ||owner.expiresAt!==record.expiresAt||cache?.status.state!=='paused'||cache?.endpoint!==null||cache?.execution!==null)
          throw failure('MANAGED_MODEL_CREDENTIAL_OWNER_INVALID');
        return owner;
      }
      if(action==='credentialBind'){
        if(result.value!==true||cache?.status.state!=='paused'||cache?.endpoint!==null||cache?.execution!==null)
          throw failure('MANAGED_MODEL_CREDENTIAL_BINDING_INVALID');
        record.credentialBound=true;
      }
      return result.value;
    };
    const next=record.tail.then(job);record.tail=next.catch(()=>{});return next;
  }
  const modelApi=freeze({
    async recoverCredentialTerminal(identity){
      if(!exact(identity,['operationId','requestDigest']))throw failure('MANAGED_MODEL_IDENTITY_INVALID');
      const bound=modelPolicy.identity(identity),record=lastCredentialFinish;
      if(!record?.credentialBound||!record.finishOutcome||!record.finishBinding||record.finishExpiresAt<=Date.now()
        ||record.signal?.aborted||closed||closing||record.terminalRecoveryPending
        ||record.finishBinding.operationId!==bound.operationId||record.finishBinding.requestDigest!==bound.requestDigest
        ||modelHold&&(modelHold.operationId!==bound.operationId||modelHold.requestDigest!==bound.requestDigest))
        throw failure('MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
      modelHold=bound;record.terminalRecoveryPending=true;invalidate();
      try{
        const result=await record.tail.then(()=>command('modelTerminalRecover',{binding:record.finishBinding}));
        terminalReceipt(result,cache,record);
        if(closed||closing||record.signal?.aborted)throw failure('MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
        record.retired=true;records.delete(record);modelHold=null;return result.value;
      }catch(error){record.retired=true;invalidate();throw error;}
      finally{record.terminalRecoveryPending=false;}
    },
    async isModelApplySupported(){return await command('modelSupported',{})===true;},
    async getModelReferenceCapabilities(){await command('modelSupported',{});return {};},
    async assertModelLease(lease,identity){const r=recordFor(lease,identity);return await invoke(r,'assert')===true;},
    async acquireModelLease(args){
      if(!plain(args)||Object.keys(args).some(k=>!['operationId','requestDigest','safeSpec','recovery','signal'].includes(k)))throw failure('MANAGED_MODEL_IDENTITY_INVALID');
      const bound=modelPolicy.identity({operationId:args.operationId,requestDigest:args.requestDigest});const recovery=args.recovery===true;
      if(args.recovery!==undefined&&typeof args.recovery!=='boolean'||args.signal!==undefined&&!(args.signal instanceof AbortSignal))throw failure('MANAGED_MODEL_IDENTITY_INVALID');
      const safeSpec=modelPolicy.spec(args.safeSpec,recovery);modelPolicy.digestMatches(safeSpec,bound.requestDigest,recovery);
      const wire=modelPolicy.wireSpec(safeSpec,recovery);
      if(modelHold&&(!recovery||modelHold.operationId!==bound.operationId||modelHold.requestDigest!==bound.requestDigest))throw failure('MANAGED_MODEL_IDENTITY_INVALID');
      if(recovery&&!modelHold)throw failure('MANAGED_MODEL_RECOVERY_OWNER_UNAVAILABLE');
      if(recovery&&lastCredentialFinish&&lastCredentialFinish.finishBinding.operationId===bound.operationId
        &&lastCredentialFinish.finishBinding.requestDigest===bound.requestDigest)throw failure('MANAGED_MODEL_TERMINAL_RECOVERY_REQUIRED');
      if(!recovery){modelHold=bound;lastCredentialFinish=null;}
      const result=responseFor(await command('modelAcquire',{...bound,recovery,...wire},null,args.signal));
      if(result.value!==true||result.binding.operationId!==bound.operationId||result.binding.requestDigest!==bound.requestDigest
        ||cache?.status.state!=='paused'||cache?.status.operationId!==bound.operationId||cache?.status.generation!==result.binding.generation
        ||cache?.status.identity?.nonce!==result.binding.writerNonce)throw failure('MANAGED_MODEL_RECEIPT_INVALID');
      for(const r of records)r.retired=true;
      const record={binding:result.binding,expiresAt:result.expiresAt,signal:args.signal,safeSpec:wire.safeSpec,recovery,retired:false,tail:Promise.resolve(),lease:null};
      const capturedSpec=s=>{const wire=modelPolicy.wireSpec(s,recovery);if(!modelPolicy.equal(wire.safeSpec,record.safeSpec))throw failure('MANAGED_MODEL_SPEC_MISMATCH');return wire.safeSpec;};
      const lease=freeze({get expiresAt(){return record.expiresAt;},
        modelRpc:(method,params={},options)=>{modelPolicy.modelParams(method,params);const phase=options===undefined?{}:credentialSchema.credentialRpcOptions(method,options);
          return invoke(record,'rpc',{method,params,...phase});},
        getCredentialOwner:()=>invoke(record,'credentialOwner'),bindCredentialPermit:permit=>invoke(record,'credentialBind',{permit:credentialSchema.credentialPermit(permit)}),
        getModelReferenceCapabilities:()=>invoke(record,'capabilities'),assertIdle:()=>invoke(record,'idle'),renew:()=>invoke(record,'renew'),
        restartPaused:()=>invoke(record,'restart'),waitHealthy:()=>invoke(record,'healthy'),
        verifyTarget:s=>invoke(record,'verify',{safeSpec:capturedSpec(s)}),convergeAfterRetire:s=>invoke(record,'converge',{safeSpec:capturedSpec(s)}),
        finish:args=>{if(!exact(args,['outcome','operationId','requestDigest','safeSpec'])||args.operationId!==bound.operationId||args.requestDigest!==bound.requestDigest)throw failure('MANAGED_MODEL_IDENTITY_INVALID');
          return invoke(record,'finish',{outcome:args.outcome,safeSpec:capturedSpec(args.safeSpec)});},
        abandon:({reason}={})=>invoke(record,'abandon',{reason})});
      record.lease=lease;leases.set(lease,record);records.add(record);return lease;
    },
  });
  const activationAuthority=freeze(Object.create(null));AUTH.add(activationAuthority);
  return freeze({activationAuthority,controller,modelApi,ready,getStatus:()=>cache?cache.status:freeze(safeStatus()),getEndpoint:()=>!modelHold&&!poisoned&&!closed&&!closing?cache?.endpoint||null:null,
    getExecution:()=>!modelHold&&!poisoned&&!closed&&!closing?cache?.execution||null:null,onProgress(callback){if(typeof callback!=='function')throw failure("MANAGED_WORKER_CALLBACK_INVALID");listeners.add(callback);return()=>listeners.delete(callback);},
    request:(method,params={},requestOptions={})=>{
      if(!plain(requestOptions)||Object.keys(requestOptions).some(key=>key!=='timeoutMs'))throw failure('MANAGED_WORKER_PARAMS_INVALID');
      return controller.request({method,params,timeoutMs:requestOptions.timeoutMs===undefined?15000:requestOptions.timeoutMs});},
    close({operationId=`close-${crypto.randomUUID()}`,timeoutMs=15000}={}){
      argsFor('stopOwned',{operationId,timeoutMs});if(closed)return Promise.resolve();if(closePromise)return closePromise;
      cleanupOperationId ||= operationId;
      const deadlineAt=Date.now()+timeoutMs;closing=true;retireModels();invalidate();cancelPending('MANAGED_WORKER_OPERATION_RETIRED');
      closePromise=(async()=>{try{
        const result=await command('stopOwned',{operationId:cleanupOperationId,timeoutMs},deadlineAt);
        if(result.ownership!=='absent')throw failure("MANAGED_WORKER_OWNED_STOP_UNVERIFIED");
        // Terminating a Worker is allowed only after its real supervisor has
        // confirmed that the captured foreground child and fence are absent.
        closed=true;cache=null;modelHold=null;lastCredentialFinish=null;clearTimeout(readyTimer);notify();port1.close();await worker.terminate();
      }catch(error){poisoned=true;cache=null;notify();const rejected=failure('MANAGED_WORKER_CLOSE_NEEDS_VERIFICATION');
        rejected.causeCode=error.code||'MANAGED_WORKER_OPERATION_FAILED';throw rejected;
      }finally{if(!closed)closePromise=null;}})();return closePromise;
    }});
}
module.exports={createManagedOpenClawHostClient,_protocol:{plain,exact,data,clone,freeze,argsFor,initFor,requestParams,validateSnapshot,serviceRootFor}};
