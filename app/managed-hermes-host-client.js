"use strict";
// Trusted App-main API. Never expose this object or its private MessagePort to
// renderer IPC; only scrubbed onProgress metadata is suitable for forwarding.
const path=require("node:path");const crypto=require("node:crypto");const fs=require("node:fs");
const {Worker,MessageChannel}=require("node:worker_threads");
const HASH=/^[a-f0-9]{64}$/;const OP=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTH=new WeakSet();
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
// Node async_hooks attaches private state to Promises at the first ALS await.
// Freeze only protocol data; lifecycle objects retain their native behavior.
function freeze(value){if(Array.isArray(value)||plain(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
const REQUEST_METHODS=Object.freeze(new Set(['session.list','session.active_list','selection_dispatch.capabilities','selection_dispatch.get','runtime.managed.status','runtime.managed.pause','runtime.managed.resume']));
function requestParams(method,params){if(!REQUEST_METHODS.has(method)||!plain(params))throw failure("MANAGED_WORKER_METHOD_UNSUPPORTED");
 const required=method.startsWith('runtime.managed.')?['operationId']:method==='selection_dispatch.capabilities'?['session_id']:method==='selection_dispatch.get'?['session_id','operation_id']:[];
 if(!exact(params,required)||Object.values(params).some(v=>typeof v!=='string'||!OP.test(v)))throw failure("MANAGED_WORKER_PARAMS_INVALID");data(params);return true;
}
function argsFor(command,args){if(!plain(args))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  const keysets={inspectSource:[],normalizeInput:[],prepareCandidate:[],getActive:[],observe:[],getCandidate:[],activateCandidate:['candidateId','operationId'],
    stopOwned:['operationId','timeoutMs'],request:['method','params','timeoutMs'],recover:[]};
  const keys=keysets[command];if(!keys||!exact(args,keys))throw failure("MANAGED_WORKER_COMMAND_INVALID");
  if(Object.hasOwn(args,'candidateId')&&!HASH.test(args.candidateId)||Object.hasOwn(args,'operationId')&&!OP.test(args.operationId))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  if(Object.hasOwn(args,'timeoutMs')&&(!Number.isSafeInteger(args.timeoutMs)||args.timeoutMs<25||args.timeoutMs>60000))throw failure("MANAGED_WORKER_PARAMS_INVALID");
  if(command==='request')requestParams(args.method,args.params);data(args);return true;
}
function serviceRootFor(value){
  if(typeof value!=='string'||Buffer.byteLength(value)>4096||!path.isAbsolute(value)||path.normalize(value)!==value)
    throw failure('MANAGED_HERMES_SERVICE_ROOT_INVALID');
  let stat;try{stat=fs.lstatSync(value);}catch{throw failure('MANAGED_HERMES_SERVICE_ROOT_INVALID');}
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid()||fs.realpathSync(value)!==value)
    throw failure('MANAGED_HERMES_SERVICE_ROOT_INVALID');
  return value;
}
function initFor(options){const keys=['stateDir','resourcesRoot','adapterResourcesRoot','sourceRoot','interpreterPath','architecture'];
  if(!keys.every(key=>typeof options[key]==='string')||!keys.slice(0,5).every(key=>path.isAbsolute(options[key]))
    ||!['arm64','x64'].includes(options.architecture))throw failure("MANAGED_WORKER_INIT_INVALID");
  const supervisorStateDir=options.supervisorStateDir===undefined?options.stateDir:options.supervisorStateDir;
  if(typeof supervisorStateDir!=='string'||!path.isAbsolute(supervisorStateDir))throw failure('MANAGED_WORKER_INIT_INVALID');
  const hermesConfiguration=clone(options.hermesConfiguration||{});
  if(!plain(hermesConfiguration)||Object.keys(hermesConfiguration).some(key=>!['model','auxiliary'].includes(key)))throw failure("MANAGED_WORKER_INIT_INVALID");
  const inputMode=options.inputMode===undefined?'normalized':options.inputMode;
  if(!['normalized','original'].includes(inputMode))throw failure("MANAGED_WORKER_INIT_INVALID");
  return {...Object.fromEntries(keys.map(key=>[key,options[key]])),supervisorStateDir,hermesConfiguration,inputMode,serviceUserDataRoot:serviceRootFor(options.serviceUserDataRoot)};
}
function validateSnapshot(value){if(!exact(value,['status','endpoint','execution','observedAt'])||!Number.isSafeInteger(value.observedAt)||value.observedAt<=0)
  throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");data(value);
  const status=value.status;
  if(!exact(status,['backendId','state','ownership','dataRoot','identity','runtimeRoot','candidateId','generation','selectionSupported','adapterGeneration','adapterInstanceId','counts','operationId'])
    ||status.backendId!=='hermes'||!['absent','managed','unknown'].includes(status.ownership)||typeof status.state!=='string'
    ||typeof status.dataRoot!=='string'||!path.isAbsolute(status.dataRoot)||typeof status.selectionSupported!=='boolean')throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");
  if(status.identity!==null&&(!exact(status.identity,['pid','startIdentity','nonce'])||!Number.isSafeInteger(status.identity.pid)||status.identity.pid<=1
    ||typeof status.identity.startIdentity!=='string'||!status.identity.startIdentity||status.identity.startIdentity.length>256||!HASH.test(status.identity.nonce)))throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");
  if(value.endpoint!==null){const e=value.endpoint;
    if(status.ownership!=='managed'||status.state!=='running'||status.selectionSupported!==true||![status.generation,status.adapterGeneration].every(id=>OP.test(id))
      ||!exact(e,['baseUrl','token','identity','dataRoot','runtimeRoot','interpreterPath','entryPath'])||typeof e.baseUrl!=='string'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(e.baseUrl)
      ||!HASH.test(e.token)||!plain(e.identity)||e.identity.pid!==status.identity?.pid||e.identity.nonce!==status.identity?.nonce
      ||e.identity.startIdentity!==status.identity?.startIdentity||e.dataRoot!==status.dataRoot||e.runtimeRoot!==status.runtimeRoot
      ||!exact(value.execution,['runtimeRoot','interpreterPath','entryPath','home','stateDir','configPath','workspace','env'])||value.execution.runtimeRoot!==e.runtimeRoot
      ||value.execution.interpreterPath!==e.interpreterPath||value.execution.entryPath!==e.entryPath)throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");
  }else if(value.execution!==null)throw failure("MANAGED_WORKER_SNAPSHOT_INVALID");
  return freeze(clone(value));
}
function createManagedHermesHostClient(options={}){
  if(!plain(options)||Object.keys(options).some(key=>!['stateDir','supervisorStateDir','resourcesRoot','adapterResourcesRoot','sourceRoot','interpreterPath','architecture','hermesConfiguration','inputMode','serviceUserDataRoot','workerFactory','commandTimeoutMs'].includes(key)))
    throw failure("MANAGED_WORKER_INIT_INVALID");
  const init=initFor(options);const channelId=crypto.randomBytes(32).toString('hex');const {port1,port2}=new MessageChannel();
  const factory=options.workerFactory||((file,workerOptions)=>new Worker(file,workerOptions));if(typeof factory!=='function')throw failure("MANAGED_WORKER_INIT_INVALID");
  if(options.commandTimeoutMs!==undefined&&(!Number.isSafeInteger(options.commandTimeoutMs)||options.commandTimeoutMs<25||options.commandTimeoutMs>600000))throw failure("MANAGED_WORKER_TIMEOUT_INVALID");
  let worker,closed=false,closing=false,closePromise=null,cleanupOperationId=null,poisoned=false,cache=null,sequence=0;const pending=new Map();const listeners=new Set();
  let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  // Avoid an unhandled rejection when a composition root observes ready later.
  ready.catch(()=>{});
  const safeStatus=()=>cache?{backendId:'hermes',state:cache.status.state,ownership:cache.status.ownership,
    selectionSupported:cache.status.selectionSupported===true,observedAt:cache.observedAt}:
    {backendId:'hermes',state:closed?'closed':poisoned?'needs_verification':closing?'stopping':'starting',ownership:'unknown',selectionSupported:false,observedAt:null};
  const notify=()=>{const value=freeze(safeStatus());for(const callback of listeners)try{callback(value);}catch{}};
  const cancelPending=code=>{const error=failure(code);for(const [id,item]of pending){
    try{port1.postMessage({type:'cancel',channelId,id});}catch{}clearTimeout(item.timer);item.reject(error);}pending.clear();};
  const clear=(code)=>{clearTimeout(readyTimer);poisoned=true;cache=null;notify();readyReject(failure(code));cancelPending(code);};
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
      pending.delete(frame.id);clearTimeout(item.timer);
      if(!poisoned&&!closed&&!closing){cache=snapshot;notify();}
      if(frame.ok)item.resolve(result);else item.reject(failure(frame.error.code));
    }catch(error){clear(error.code||"MANAGED_WORKER_PROTOCOL_INVALID");}
  });
  port1.on('messageerror',()=>clear("MANAGED_WORKER_MESSAGE_INVALID"));port1.on('close',()=>{if(!closed)clear("MANAGED_WORKER_DISCONNECTED");});
  const readyTimer=setTimeout(()=>clear("MANAGED_WORKER_READY_TIMEOUT"),15000);
  try{worker=factory(path.join(__dirname,'managed-hermes-host-worker.js'),{workerData:{version:1,channelId,init,port:port2},transferList:[port2]});}
  catch(error){clearTimeout(readyTimer);port1.close();port2.close();clear("MANAGED_WORKER_START_FAILED");throw error;}
  worker.on('error',()=>{clearTimeout(readyTimer);clear("MANAGED_WORKER_FAILED");});
  worker.on('exit',()=>{clearTimeout(readyTimer);if(!closed)clear("MANAGED_WORKER_EXITED");});
  const timeouts={inspectSource:120000,normalizeInput:600000,prepareCandidate:600000,activateCandidate:180000,getCandidate:120000,getActive:120000,observe:15000,recover:15000,stopOwned:60000,request:60000};
  async function command(kind,args={},cleanupDeadlineAt=null){
    argsFor(kind,args);if(closed||(poisoned||closing)&&!['stopOwned','observe','recover'].includes(kind))throw failure("MANAGED_WORKER_UNAVAILABLE");
    await ready;if(closed||(poisoned||closing)&&!['stopOwned','observe','recover'].includes(kind))throw failure("MANAGED_WORKER_UNAVAILABLE");
    const timeoutMs=cleanupDeadlineAt===null?(kind==='stopOwned'||kind==='request'?args.timeoutMs+1000:options.commandTimeoutMs||timeouts[kind]):cleanupDeadlineAt-Date.now();
    if(timeoutMs<=0)throw failure("MANAGED_WORKER_CLOSE_NEEDS_VERIFICATION");
    const id=`host-${++sequence}`;if(['activateCandidate','stopOwned'].includes(kind)||kind==='request'&&['runtime.managed.pause','runtime.managed.resume'].includes(args.method))invalidate();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);try{port1.postMessage({type:'cancel',channelId,id});}catch{}
        clear("MANAGED_WORKER_COMMAND_TIMEOUT");reject(failure("MANAGED_WORKER_COMMAND_TIMEOUT"));},timeoutMs);
      pending.set(id,{resolve,reject,timer,command:kind});
      try{port1.postMessage({type:'command',channelId,id,command:kind,args:clone(args),deadlineAt:Date.now()+timeoutMs});}
      catch{pending.delete(id);clearTimeout(timer);clear("MANAGED_WORKER_DISCONNECTED");reject(failure("MANAGED_WORKER_DISCONNECTED"));}
    });
  }
  const controller=freeze({inspectSource:(args={})=>command('inspectSource',args),normalizeInput:(args={})=>command('normalizeInput',args),prepareCandidate:(args={})=>command('prepareCandidate',args),
    activateCandidate:args=>command('activateCandidate',args),getCandidate:args=>command('getCandidate',args),getActive:(args={})=>command('getActive',args),
    observe:(args={})=>command('observe',args),recover:(args={})=>command('recover',args),
    stopOwned:({operationId=`stop-${crypto.randomUUID()}`,timeoutMs=15000}={})=>command('stopOwned',{operationId,timeoutMs}),
    request:({method,params={},timeoutMs=15000}={})=>command('request',{method,params,timeoutMs})});
  const activationAuthority=Object.freeze(Object.create(null));AUTH.add(activationAuthority);
  return freeze({activationAuthority,controller,ready,getStatus:()=>cache?cache.status:freeze(safeStatus()),getEndpoint:()=>!poisoned&&!closed&&!closing?cache?.endpoint||null:null,
    getExecution:()=>!poisoned&&!closed&&!closing?cache?.execution||null:null,onProgress(callback){if(typeof callback!=='function')throw failure("MANAGED_WORKER_CALLBACK_INVALID");listeners.add(callback);return()=>listeners.delete(callback);},
    request:(method,params={},requestOptions={})=>{
      if(!plain(requestOptions)||Object.keys(requestOptions).some(key=>key!=='timeoutMs'))throw failure('MANAGED_WORKER_PARAMS_INVALID');
      return controller.request({method,params,timeoutMs:requestOptions.timeoutMs===undefined?15000:requestOptions.timeoutMs});},
    close({operationId=`close-${crypto.randomUUID()}`,timeoutMs=15000}={}){
      argsFor('stopOwned',{operationId,timeoutMs});if(closed)return Promise.resolve();if(closePromise)return closePromise;
      cleanupOperationId ||= operationId;
      const deadlineAt=Date.now()+timeoutMs;closing=true;invalidate();cancelPending('MANAGED_WORKER_OPERATION_RETIRED');
      closePromise=(async()=>{try{
        const result=await command('stopOwned',{operationId:cleanupOperationId,timeoutMs},deadlineAt);
        if(result.ownership!=='absent')throw failure("MANAGED_WORKER_OWNED_STOP_UNVERIFIED");
        // Terminating a Worker is allowed only after its real supervisor has
        // confirmed that the captured foreground child and fence are absent.
        closed=true;cache=null;clearTimeout(readyTimer);notify();port1.close();await worker.terminate();
      }catch(error){poisoned=true;cache=null;notify();const rejected=failure('MANAGED_WORKER_CLOSE_NEEDS_VERIFICATION');
        rejected.causeCode=error.code||'MANAGED_WORKER_OPERATION_FAILED';throw rejected;
      }finally{if(!closed)closePromise=null;}})();return closePromise;
    }});
}
module.exports={createManagedHermesHostClient,_protocol:{plain,exact,data,clone,freeze,argsFor,initFor,requestParams,validateSnapshot,serviceRootFor}};
