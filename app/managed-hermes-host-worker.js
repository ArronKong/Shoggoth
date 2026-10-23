"use strict";
const fs=require("node:fs");const path=require("node:path");const crypto=require("node:crypto");
const {workerData,MessagePort,receiveMessageOnPort}=require("node:worker_threads");
const {createManagedPluginHostRuntimeManager,createManagedHostRuntimeAuthority}=require("./managed-plugin-host-runtime");
const {createManagedHermesHostSupervisor}=require("./managed-hermes-host-supervisor");
const {_protocol:p}=require("./managed-hermes-host-client");
const pins=require("./managed-hermes-runtime-pins.json");
const {prepareManagedHermesProductInput}=require("./managed-hermes-product-inputs");
const failure=code=>Object.assign(new Error(code),{code});
if(!p.exact(workerData,['version','channelId','init','port'])||workerData.version!==1||!/^[a-f0-9]{64}$/.test(workerData.channelId)
  ||!(workerData.port instanceof MessagePort)||!p.exact(workerData.init,['stateDir','supervisorStateDir','resourcesRoot','adapterResourcesRoot','sourceRoot','interpreterPath','architecture','hermesConfiguration','inputMode','serviceUserDataRoot']))
  throw failure("MANAGED_WORKER_INIT_INVALID");
const init=p.initFor(workerData.init);const port=workerData.port;const channelId=workerData.channelId;
let configuration=p.clone(init.hermesConfiguration);let active=null;let connected=true;let observed=null;let ownedPause=null;let queue=Promise.resolve();let pumping=false;
const send=value=>{if(connected)port.postMessage({channelId,...value});};
function readOwnedConfig(file){
  const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>1024*1024
    ||(before.mode&0o077)!==0||process.getuid&&before.uid!==process.getuid())throw failure("MANAGED_WORKER_CONFIG_UNSAFE");
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const start=fs.fstatSync(fd);if(start.dev!==before.dev||start.ino!==before.ino)throw failure("MANAGED_WORKER_CONFIG_CHANGED");
    const value=require('js-yaml').load(fs.readFileSync(fd,'utf8'));const end=fs.fstatSync(fd);
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
const supervisor=createManagedHermesHostSupervisor({stateDir:hostState,adapterResourcesRoot:init.adapterResourcesRoot,
  getHermesConfiguration:()=>configuration,serviceUserDataRoot:init.serviceUserDataRoot});
function preserveConfiguration(){const file=path.join(supervisor.getStatus().dataRoot,'config.yaml');
  if(fs.existsSync(file)){const current=readOwnedConfig(file);configuration=p.clone(Object.fromEntries(['model','auxiliary']
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
function snapshot(){const status=supervisor.getStatus();const usable=status.ownership==='managed'&&status.state==='running'&&status.selectionSupported===true;
 return {status,endpoint:usable?supervisor.getEndpoint():null,execution:usable?supervisor.getExecution():null,observedAt:Date.now()};
}
async function observe(){return supervisor.observe({operationId:'observe-'+crypto.randomUUID(),timeoutMs:10000,signal:active?.abort.signal});}
let normalizedInput=null;
const inputStateDir=path.join(path.dirname(path.resolve(init.stateDir)),path.basename(init.stateDir)+'.hermes-normalized-inputs');
async function sourceArgs(){
  assertOperation();
  if(init.inputMode==='original'&&!normalizedInput){
    if(inside(sourceRoot,inputStateDir)||inside(inputStateDir,sourceRoot)||inside(path.resolve(init.stateDir),inputStateDir)
      ||inside(inputStateDir,path.resolve(init.stateDir))||inside(hostState,inputStateDir)||inside(inputStateDir,hostState))
      throw failure('MANAGED_WORKER_SOURCE_STATE_OVERLAP');
    normalizedInput=await prepareManagedHermesProductInput({sourceRoot,inputStateDir,resourcesRoot:init.resourcesRoot,architecture:init.architecture,
      assertCurrent:assertOperation,signal:active.abort.signal,onProgress:state=>send({type:'progress',state:'normalize_'+state})});
    assertOperation();
  }
  const input=normalizedInput||init;
  return {backendId:'hermes',sourceRoot:input.sourceRoot,interpreterPath:input.interpreterPath,architecture:input.architecture};
}
async function execute(command,args){assertOperation();switch(command){
  case'inspectSource':return manager.inspectSource(await sourceArgs());
  case'normalizeInput':return {...await sourceArgs(),inputMode:init.inputMode,inputTreeSha256:normalizedInput?.inputTreeSha256||null,reused:normalizedInput?.reused||false};
  case'prepareCandidate':return manager.prepareCandidate(await sourceArgs());
  case'getCandidate':return manager.getCandidate('hermes');
  case'getActive':return manager.getActive('hermes');
  case'activateCandidate':preserveConfiguration();observed=null;ownedPause=null;return manager.activateCandidate({backendId:'hermes',...args});
  case'observe':return observe();
  case'recover':return {status:await observe(),active:manager.getActive('hermes'),adoptionSupported:false};
  case'stopOwned':{
    const timeoutMs=Math.min(args.timeoutMs,active.deadlineAt-Date.now());
    if(timeoutMs<=0)throw failure('MANAGED_WORKER_OPERATION_RETIRED');
    return supervisor.stopOwned({operationId:args.operationId,timeoutMs,signal:active.abort.signal});}
  case'request':{
    if(args.method.startsWith('runtime.managed.'))return supervisor.manage(args.method.slice('runtime.managed.'.length),{
      operationId:args.params.operationId,timeoutMs:Math.min(args.timeoutMs,active.deadlineAt-Date.now()),signal:active.abort.signal});
    return supervisor.request(args.method,args.params,{timeoutMs:Math.min(args.timeoutMs,active.deadlineAt-Date.now()),signal:active.abort.signal});}
  default:throw failure("MANAGED_WORKER_COMMAND_INVALID");}}
const canceled=new Set();
async function dispatch(frame){
  if(canceled.delete(frame.id))return;
  const abort=new AbortController();active={id:frame.id,deadlineAt:frame.deadlineAt,abort};
  send({type:'progress',state:frame.command});let result=null;let error=null;
  try{assertOperation();result=await execute(frame.command,frame.args);assertOperation();p.data(result);}
  catch(caught){error={code:typeof caught.code==='string'&&/^[A-Za-z0-9_]+$/.test(caught.code)?caught.code:'MANAGED_WORKER_OPERATION_FAILED'};}
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
port.on('close',()=>{connected=false;active?.abort.abort(failure("MANAGED_WORKER_DISCONNECTED"));queue=queue.then(()=>supervisor.stopOwned({operationId:'private-port-disconnected',timeoutMs:60000})).catch(()=>{});});
port.on('messageerror',()=>{connected=false;active?.abort.abort(failure("MANAGED_WORKER_MESSAGE_INVALID"));});
send({type:'ready',snapshot:snapshot()});
setInterval(()=>{if(!connected||active)return;queue=queue.then(async()=>{try{await observe();send({type:'snapshot',snapshot:snapshot()});}
  catch{observed=null;send({type:'snapshot',snapshot:{status:{...supervisor.getStatus(),state:'needs_verification',operationId:null},endpoint:null,execution:null,observedAt:Date.now()}});}}).catch(()=>{});},3000).unref();
