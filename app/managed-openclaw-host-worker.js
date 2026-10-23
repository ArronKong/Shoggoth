"use strict";
const fs=require("node:fs");const path=require("node:path");const crypto=require("node:crypto");
const {workerData,MessagePort,receiveMessageOnPort}=require("node:worker_threads");
const {createManagedPluginHostRuntimeManager,createManagedHostRuntimeAuthority}=require("./managed-plugin-host-runtime");
const {createManagedOpenClawHostSupervisor}=require("./managed-openclaw-host-supervisor");
const {_protocol:p}=require("./managed-openclaw-host-client");
const pins=require("./managed-openclaw-runtime-pins.json");
const failure=code=>Object.assign(new Error(code),{code});
if(!p.exact(workerData,['version','channelId','init','port'])||workerData.version!==1||!/^[a-f0-9]{64}$/.test(workerData.channelId)
  ||!(workerData.port instanceof MessagePort)||!p.exact(workerData.init,['stateDir','supervisorStateDir','resourcesRoot','adapterResourcesRoot','sourceRoot','interpreterPath','architecture','gatewayConfiguration','serviceUserDataRoot']))
  throw failure("MANAGED_WORKER_INIT_INVALID");
const init=p.initFor(workerData.init);const port=workerData.port;const channelId=workerData.channelId;
let modelOperation=null;let configuration=p.clone(init.gatewayConfiguration);let active=null;let connected=true;let observed=null;let ownedPause=null;let queue=Promise.resolve();let pumping=false;
const send=value=>{if(connected)port.postMessage({channelId,...value});};
function readOwnedConfig(file){
  const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>1024*1024
    ||(before.mode&0o077)!==0||process.getuid&&before.uid!==process.getuid())throw failure("MANAGED_WORKER_CONFIG_UNSAFE");
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const start=fs.fstatSync(fd);if(start.dev!==before.dev||start.ino!==before.ino)throw failure("MANAGED_WORKER_CONFIG_CHANGED");
    const value=JSON.parse(fs.readFileSync(fd,'utf8'));const end=fs.fstatSync(fd);
    if(end.size!==start.size||end.mtimeMs!==start.mtimeMs||end.ctimeMs!==start.ctimeMs)throw failure("MANAGED_WORKER_CONFIG_CHANGED");
    p.data(value);return value;
  }finally{fs.closeSync(fd);}
}
const inside=(root,value)=>value===root||value.startsWith(root+path.sep);
const hostState=path.resolve(init.supervisorStateDir);const sourceRoot=fs.realpathSync(init.sourceRoot);
if(inside(sourceRoot,hostState)||inside(hostState,sourceRoot)||inside(path.join(path.resolve(init.stateDir),'external-plugin-host-runtimes'),hostState))
  throw failure('MANAGED_WORKER_SOURCE_STATE_OVERLAP');
// The supervisor checks canonical UID-owned 0700/no-symlink directories and
// captures only its own data-root fence. Manager candidates remain fixed-policy
// immutable code; separating these two trusted roots does not adopt a writer.
const supervisor=createManagedOpenClawHostSupervisor({stateDir:hostState,adapterResourcesRoot:init.adapterResourcesRoot,
  getGatewayConfiguration:()=>configuration,serviceUserDataRoot:init.serviceUserDataRoot});
function preserveConfiguration(){const file=path.join(supervisor.getStatus().dataRoot,'openclaw.json');
  if(fs.existsSync(file)){const current=readOwnedConfig(file);configuration=p.clone(Object.fromEntries(['models','agents','tools']
    .filter(key=>Object.hasOwn(current,key)).map(key=>[key,current[key]])));}}
// Hash/copy work is synchronous inside this Worker. Pull cancellation frames at
// every effect boundary so queued microtasks cannot start a retired operation
// before the event loop delivers its normal MessagePort callbacks.
function pumpMessages(){if(pumping)return;pumping=true;try{let frame;while((frame=receiveMessageOnPort(port)))handleFrame(frame.message);}finally{pumping=false;}}
function assertOperation(){pumpMessages();if(!active||active.abort.signal.aborted||!connected||active.deadlineAt<=Date.now())
  throw failure("MANAGED_WORKER_OPERATION_RETIRED");}
function contextFor(context,cleanup=false){if(cleanup)return context;assertOperation();
  const command=active;return {...context,deadlineAt:Math.min(context.deadlineAt,command.deadlineAt),
    signal:AbortSignal.any([context.signal,command.abort.signal]),assertCurrent(){assertOperation();context.assertCurrent();
      if(command!==active||command.abort.signal.aborted||!connected||command.deadlineAt<=Date.now())throw failure("MANAGED_WORKER_OPERATION_RETIRED");}};}
const wrapped={};
for(const [name,method]of Object.entries(supervisor.controller))wrapped[name]=async context=>{
  const cleanup=['failClosed','abortAndWait'].includes(name);const guarded=contextFor(context,cleanup);
  const result=await method(guarded);if(!cleanup)assertOperation();
  if(!cleanup&&result&&typeof result.assertValid==='function')return {
    assertValid:ctx=>result.assertValid(contextFor(ctx)),release:ctx=>result.release(ctx)};
  if(!cleanup)send({type:'progress',state:name});return result;
};
const manager=createManagedPluginHostRuntimeManager({stateDir:init.stateDir,resourcesRoot:init.resourcesRoot,inputPins:pins,
  activationAuthority:createManagedHostRuntimeAuthority(wrapped),stageTimeoutMs:60000});
function snapshot(){const base=supervisor.getStatus();let status={...base,operationId:null};
  if(observed&&base.identity&&observed.pid===base.identity.pid&&observed.nonce===base.identity.nonce
    &&!(base.state==='paused'&&observed.paused!==true)){
    status={...status,state:observed.paused?'paused':base.state,generation:observed.generation,selectionSupported:observed.selectionSupported,
      adapterGeneration:observed.adapterGeneration,adapterInstanceId:observed.adapterInstanceId,counts:observed.snapshot.counts,operationId:observed.operationId};}
  if(base.state==='paused'&&modelOperation)status.operationId=modelOperation;
  if(base.state==='paused'&&!modelOperation&&ownedPause&&sameOwnedIdentity(ownedPause.identity,base.identity))status.operationId=ownedPause.operationId;
  const usable=status.ownership==='managed'&&status.state==='running'&&status.selectionSupported===true;
  return {status,endpoint:usable?supervisor.getEndpoint():null,execution:usable?supervisor.getExecution():null,observedAt:Date.now()};
}
function proofMatches(value){const status=supervisor.getStatus();return p.plain(value)&&value.version===1&&value.protocol==='openclaw-managed-v1'
  &&value.backendId==='openclaw'&&value.pid===status.identity?.pid&&value.nonce===status.identity?.nonce&&value.dataRoot===status.dataRoot
  &&value.runtimeRoot===status.runtimeRoot&&value.runtimeTreeSha256===pins.hosts.openclaw.outputTreeSha256
  &&value.generation===status.generation&&typeof value.paused==='boolean'&&p.plain(value.snapshot)&&p.plain(value.snapshot.counts);}
function sameOwnedIdentity(a,b){return a&&b&&a.pid===b.pid&&a.startIdentity===b.startIdentity&&a.nonce===b.nonce;}
async function coreRequest(method,args,timeoutMs,signal){
  const status=supervisor.getStatus();if(!supervisor.getEndpoint())throw failure("MANAGED_HOST_ENDPOINT_UNVERIFIED");
  const desc=readOwnedConfig(path.join(status.dataRoot,'managed-control.json'));
  const deadlineAt=Math.min(active?.deadlineAt||Date.now()+timeoutMs,Date.now()+timeoutMs);
  const result=await supervisor.request(method,{version:1,controlToken:desc.controlToken,nonce:status.identity.nonce,operationId:args.operationId,
    deadlineAt,generation:status.generation},{timeoutMs,signal});
  if(!proofMatches(result))throw failure("MANAGED_WORKER_HOST_PROOF_INVALID");observed=result;return result;
}
async function observe(){const context={backendId:'openclaw',operationId:`observe-${crypto.randomUUID()}`,deadlineAt:Date.now()+10000,
  signal:active?.abort.signal||new AbortController().signal,assertCurrent(){}};
  await supervisor.controller.inspectWriter(context);
  if(supervisor.getEndpoint())await coreRequest('gateway.shoggoth.managed.status',{operationId:context.operationId},9000,context.signal);
  return snapshot().status;}
const sourceArgs=()=>({backendId:'openclaw',sourceRoot:init.sourceRoot,interpreterPath:init.interpreterPath,architecture:init.architecture});
async function execute(command,args){assertOperation();switch(command){
  case'inspectSource':return manager.inspectSource(sourceArgs());
  case'prepareCandidate':return manager.prepareCandidate(sourceArgs());
  case'getCandidate':return manager.getCandidate('openclaw');
  case'getActive':return manager.getActive('openclaw');
  case'activateCandidate':if(modelOperation)throw failure('MANAGED_MODEL_UNAVAILABLE');preserveConfiguration();observed=null;ownedPause=null;return manager.activateCandidate({backendId:'openclaw',...args});
  case'observe':return observe();
  case'recover':return {status:await observe(),active:manager.getActive('openclaw'),adoptionSupported:false};
  case'stopOwned':{
    const status=supervisor.getStatus();const retainedPause=observed?.paused===true&&proofMatches(observed)
      &&observed.pid===status.identity?.pid&&observed.nonce===status.identity?.nonce;
    const operationId=retainedPause?observed.operationId:status.state==='paused'&&sameOwnedIdentity(ownedPause?.identity,status.identity)?ownedPause.operationId:args.operationId;
    const timeoutMs=Math.min(args.timeoutMs,active.deadlineAt-Date.now());
    if(timeoutMs<=0)throw failure('MANAGED_WORKER_OPERATION_RETIRED');
    try{const result=await supervisor.stopOwned({operationId,timeoutMs});observed=null;ownedPause=null;modelOperation=null;return result;}
    catch(error){const after=supervisor.getStatus();
      // The supervisor changes state to paused only after authenticated pause
      // proof. Retain that exact captured owner's operation for an explicit
      // cleanup retry, without inventing adoption from persisted descriptors.
      if(after.state==='paused'&&sameOwnedIdentity(status.identity,after.identity))ownedPause={operationId,identity:{...after.identity}};
      throw error;}}
  case'modelSupported':{
    const context={operationId:`model-support-${crypto.randomUUID()}`,deadlineAt:active.deadlineAt,signal:active.abort.signal,assertCurrent:assertOperation};
    return supervisor.modelController.isSupported(context);}
  case'modelAcquire':{
    observed=null;
    const context={operationId:args.operationId,deadlineAt:active.deadlineAt,signal:active.abort.signal,assertCurrent:assertOperation};
    try{return await supervisor.modelController.acquire(args,context);}finally{modelOperation=supervisor.modelController.getOperationId();}}
  case'modelTerminalRecover':{
    observed=null;
    const context={operationId:args.binding.operationId,deadlineAt:active.deadlineAt,signal:active.abort.signal,assertCurrent:assertOperation};
    try{return await supervisor.modelController.recoverCredentialTerminal(args.binding,context);}
    finally{modelOperation=supervisor.modelController.getOperationId();}}
  case'modelAction':{
    observed=null;
    const context={operationId:args.binding.operationId,deadlineAt:active.deadlineAt,signal:active.abort.signal,assertCurrent:assertOperation};
    const result=await supervisor.modelController.action(args.binding,args.action,args.params,context);
    if(args.action==='finish')modelOperation=null;return result;}
  case'request':{
    if(args.method==='gateway.shoggoth.managed.resume'){
      const context={backendId:'openclaw',operationId:args.params.operationId,
        deadlineAt:Math.min(active.deadlineAt,Date.now()+args.timeoutMs),signal:active.abort.signal,assertCurrent:assertOperation};
      await supervisor.controller.assertIdle(context);assertOperation();
    }
    if(args.method.startsWith('gateway.shoggoth.managed.'))return coreRequest(args.method,args.params,args.timeoutMs,active.abort.signal);
    return supervisor.request(args.method,args.params,{timeoutMs:args.timeoutMs,signal:active.abort.signal});}
  default:throw failure("MANAGED_WORKER_COMMAND_INVALID");}}
const canceled=new Set();
async function dispatch(frame){
  if(canceled.delete(frame.id))return;
  const abort=new AbortController();active={id:frame.id,deadlineAt:frame.deadlineAt,abort};
  send({type:'progress',state:frame.command});let result=null;let error=null;
  try{assertOperation();result=await execute(frame.command,frame.args);assertOperation();p.data(result);}
  catch(caught){
    // A late local cancellation after the physical resume must withdraw that
    // same captured writer; it cannot authorize another recovery dispatch.
    if(result!==null&&(frame.command==='modelTerminalRecover'||frame.command==='modelAction'&&frame.args.action==='finish')){
      try{await supervisor.modelController.withdrawCredentialTerminal(frame.args.binding);}catch{}
      modelOperation=supervisor.modelController.getOperationId();
    }
    error={code:typeof caught.code==='string'&&/^[A-Za-z0-9_]+$/.test(caught.code)?caught.code:'MANAGED_WORKER_OPERATION_FAILED'};}
  finally{active=null;}
  send({type:'response',id:frame.id,ok:error===null,result:error===null?result:null,error,snapshot:snapshot()});
}
function handleFrame(frame){
  try{
    if(!p.plain(frame)||frame.channelId!==channelId)throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
    if(frame.type==='cancel'){
      if(!p.exact(frame,['type','channelId','id'])||typeof frame.id!=='string')throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
      if(active?.id===frame.id)active.abort.abort(failure("MANAGED_WORKER_OPERATION_RETIRED"));
      else{canceled.add(frame.id);if(canceled.size>128)throw failure("MANAGED_WORKER_PROTOCOL_INVALID");}return;
    }
    if(frame.type!=='command'||!p.exact(frame,['type','channelId','id','command','args','deadlineAt'])||typeof frame.id!=='string'
      ||!/^host-\d+$/.test(frame.id)||!Number.isSafeInteger(frame.deadlineAt)||frame.deadlineAt>Date.now()+601000)
      throw failure("MANAGED_WORKER_PROTOCOL_INVALID");
    p.argsFor(frame.command,frame.args);
    if(frame.deadlineAt<=Date.now()){send({type:'response',id:frame.id,ok:false,result:null,error:{code:'MANAGED_WORKER_OPERATION_RETIRED'},snapshot:snapshot()});return;}
    queue=queue.then(()=>dispatch(frame)).catch(()=>{});
  }catch(error){send({type:'protocol-error',code:error.code});connected=false;active?.abort.abort(error);port.close();}
}
port.on('message',handleFrame);
port.on('close',()=>{connected=false;active?.abort.abort(failure("MANAGED_WORKER_DISCONNECTED"));});
port.on('messageerror',()=>{connected=false;active?.abort.abort(failure("MANAGED_WORKER_MESSAGE_INVALID"));});
send({type:'ready',snapshot:snapshot()});
setInterval(()=>{if(!connected||active)return;queue=queue.then(async()=>{try{await observe();send({type:'snapshot',snapshot:snapshot()});}
  catch{observed=null;send({type:'snapshot',snapshot:{status:{...supervisor.getStatus(),state:'needs_verification',operationId:null},endpoint:null,execution:null,observedAt:Date.now()}});}}).catch(()=>{});},3000).unref();
