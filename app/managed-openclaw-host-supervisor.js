"use strict";
// Trusted App composition only. Owns a foreground fixed Host on a new private
// data root; it never discovers, adopts, replaces or kills a global daemon.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { WebSocket } = require("ws");
const { generateIdentity, buildConnectParams } = require("./core/device-auth");
const { createManagedHostRuntimeAuthority, hashFile, snapshotRuntimeTree } = require("./managed-plugin-host-runtime");
const pins = require("./managed-openclaw-runtime-pins.json");
const modelPolicy=require("./managed-openclaw-model-policy");
const credentialPolicy=require("./managed-openclaw-provider-credential");
const credentialSchema=require("./managed-openclaw-provider-credential-schema");
const credentialEffect=require("./managed-openclaw-provider-credential-policy");
const {NATIVE_AUTH_API,nativeAuthProviderScope,resolveNativeAuthAgent,nativeAuthAgentIds}=require("./managed-openclaw-auth-profile-scope");
const {createManagedOpenClawProviderCredentialClient}=require("./managed-openclaw-provider-credential-client");
const {createManagedProviderCredentialFinishGate}=require("./managed-openclaw-provider-credential-finish");
const {createManagedProviderTerminalRecoveryGate}=require("./managed-openclaw-provider-terminal-recovery");
const {matchesManagedConfigRevision}=require("./managed-openclaw-config-revision");
const {createManagedConfigSourceLedger}=require("./managed-openclaw-config-source-ledger");
const {runNativeModelMethod}=require("./managed-openclaw-native-config");
const {pathToFileURL}=require("node:url");
const ID = "shoggoth-shared-capabilities";
const HASH = /^[a-f0-9]{64}$/;
const OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADAPTER_FILES = ["index.mjs", "openclaw.plugin.json", "package.json", "transport.mjs"];
const fail = code => Object.assign(new Error(code), { code });
const requireValue = (value, code) => { if (!value) throw fail(code); };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (a,b) => a && b && ["pid","startIdentity","nonce"].every(key=>a[key]===b[key]);
function privateDir(dir) {
  try { fs.mkdirSync(dir,{mode:0o700}); } catch(error) { if(error.code!=="EEXIST") throw error; }
  const s=fs.lstatSync(dir);
  requireValue(s.isDirectory() && !s.isSymbolicLink() && (s.mode&0o077)===0
    && (!process.getuid || s.uid===process.getuid()) && fs.realpathSync(dir)===dir,"MANAGED_HOST_PRIVATE_PATH_UNSAFE");
}
function readPrivate(file) {
  const before=fs.lstatSync(file);
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink===1 && before.size<=1024*1024
    && (before.mode&0o077)===0 && (!process.getuid || before.uid===process.getuid()),"MANAGED_HOST_PRIVATE_FILE_UNSAFE");
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try {
    const start=fs.fstatSync(fd); requireValue(start.dev===before.dev && start.ino===before.ino,"MANAGED_HOST_FILE_CHANGED");
    const bytes=fs.readFileSync(fd); const end=fs.fstatSync(fd);
    requireValue(end.size===start.size && end.mtimeMs===start.mtimeMs && end.ctimeMs===start.ctimeMs,"MANAGED_HOST_FILE_CHANGED");
    return bytes;
  } finally {fs.closeSync(fd);}
}
function writePrivate(file,value) {
  if (fs.existsSync(file)) readPrivate(file);
  const temporary=path.join(path.dirname(file),`.${path.basename(file)}-${crypto.randomUUID()}`);
  const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
  try {fs.writeFileSync(fd,JSON.stringify(value,null,2)+"\n");fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(temporary,file);
  const directory=fs.openSync(path.dirname(file),fs.constants.O_RDONLY);try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
}
function startIdentity(pid) {
  const result=spawnSync("/bin/ps",["-p",String(pid),"-o","lstart="],{encoding:"utf8",timeout:1500,maxBuffer:4096});
  requireValue(!result.error && result.status===0 && result.stdout.trim(),"MANAGED_HOST_PROCESS_IDENTITY_UNAVAILABLE");
  return result.stdout.trim();
}
const wait = (ms,signal) => new Promise((resolve,reject)=>{
  if(signal?.aborted) return reject(signal.reason || fail("MANAGED_HOST_ABORTED"));
  const timer=setTimeout(()=>{signal?.removeEventListener("abort",cancel);resolve();},ms);
  const cancel=()=>{clearTimeout(timer);reject(signal.reason || fail("MANAGED_HOST_ABORTED"));};
  signal?.addEventListener("abort",cancel,{once:true});
});
function guard(context,cleanup=false) {
  requireValue(context && OP.test(context.operationId) && Number.isSafeInteger(context.deadlineAt)
    && context.deadlineAt>Date.now(),"MANAGED_HOST_DEADLINE_EXPIRED");
  if(!cleanup) {context.signal?.throwIfAborted();context.assertCurrent?.();}
}
function freePort() {
  return new Promise((resolve,reject)=>{const server=net.createServer();server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
}
async function connect(url,token,signal,timeoutMs) {
  const socket=new WebSocket(url,{headers:{Origin:"http://127.0.0.1"}});
  const identity=generateIdentity();const pending=new Map();let counter=0;let sent=false;
  let readyResolve,readyReject; const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const request=(method,params={},options={})=>new Promise((resolve,reject)=>{
    if(options.signal?.aborted) return reject(options.signal.reason || fail("MANAGED_HOST_ABORTED"));
    if(socket.readyState!==WebSocket.OPEN) return reject(fail("MANAGED_HOST_CONNECTION_CLOSED"));
    const id=`managed-${++counter}`;
    const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener("abort",cancel);pending.delete(id);};
    const cancel=()=>{cleanup();reject(options.signal.reason || fail("MANAGED_HOST_ABORTED"));};
    const timer=setTimeout(()=>{cleanup();reject(fail("MANAGED_HOST_RPC_TIMEOUT"));},options.timeoutMs||timeoutMs);
    pending.set(id,{resolve:value=>{cleanup();resolve(value);},reject:error=>{cleanup();reject(error);}});
    options.signal?.addEventListener("abort",cancel,{once:true});
    socket.send(JSON.stringify({type:"req",id,method,params}),error=>{if(error){cleanup();reject(error);}});
  });
  const failed=error=>{readyReject(error);for(const item of [...pending.values()]) item.reject(error);};
  socket.on("error",failed);socket.on("close",()=>failed(fail("MANAGED_HOST_CONNECTION_CLOSED")));
  socket.on("message",bytes=>{let frame;try {frame=JSON.parse(bytes.toString());} catch {return failed(fail("MANAGED_HOST_FRAME_INVALID"));}
    if(frame.type==="event" && frame.event==="connect.challenge" && !sent) {
      sent=true;void request("connect",buildConnectParams({...identity,token,scopes:["operator.read","operator.write","operator.admin"]},frame.payload?.nonce))
        .then(readyResolve,readyReject);return;
    }
    if(frame.type!=="res") return;const item=pending.get(frame.id);if(!item)return;
    if(frame.ok)item.resolve(frame.payload);else item.reject(Object.assign(new Error(frame.error?.message||"MANAGED_HOST_RPC_REJECTED"),{code:frame.error?.code}));
  });
  const cancel=()=>{socket.terminate();failed(signal.reason||fail("MANAGED_HOST_ABORTED"));};signal?.addEventListener("abort",cancel,{once:true});
  const timer=setTimeout(()=>{socket.terminate();failed(fail("MANAGED_HOST_CONNECT_TIMEOUT"));},timeoutMs);
  try {await ready;} catch(error) {socket.terminate();throw error;} finally {clearTimeout(timer);signal?.removeEventListener("abort",cancel);}
  return {request,close:()=>socket.terminate(),isOpen:()=>socket.readyState===WebSocket.OPEN};
}
function createManagedOpenClawHostSupervisor(options={}) {
  requireValue(typeof options.stateDir==="string" && path.isAbsolute(options.stateDir)
    && typeof options.adapterResourcesRoot==="string" && path.isAbsolute(options.adapterResourcesRoot),"MANAGED_HOST_OPTIONS_REQUIRED");
  const serviceRoot=require('./managed-openclaw-host-client')._protocol.serviceRootFor(options.serviceUserDataRoot);
  const serviceAnchor=fs.lstatSync(serviceRoot);
  const assertServiceRoot=()=>{
    requireValue(require('./managed-openclaw-host-client')._protocol.serviceRootFor(serviceRoot)===serviceRoot,
      'MANAGED_OPENCLAW_SERVICE_ROOT_INVALID');
    const current=fs.lstatSync(serviceRoot);
    requireValue(current.dev===serviceAnchor.dev&&current.ino===serviceAnchor.ino,'MANAGED_OPENCLAW_SERVICE_ROOT_CHANGED');
    return serviceRoot;
  };
  const credentialChannel=createManagedOpenClawProviderCredentialClient({serviceUserDataRoot:serviceRoot,assertCurrent(){assertServiceRoot();return true;}});
  const stateDir=path.resolve(options.stateDir);privateDir(stateDir);
  const parent=path.join(stateDir,"external-plugin-host-data");privateDir(parent);
  const backendRoot=path.join(parent,"openclaw");privateDir(backendRoot);
  const dataRoot=path.join(backendRoot,"v1");privateDir(dataRoot);
  const marker=path.join(dataRoot,"owner-root.json");
  if(!fs.existsSync(marker)) {
    // A populated unmarked directory is never adopted as our data root.
    requireValue(fs.readdirSync(dataRoot).length===0,"MANAGED_HOST_UNKNOWN_DATA_OWNER");
    writePrivate(marker,{version:1,backendId:"openclaw",rootId:crypto.randomUUID()});
  }
  const rootMarker=JSON.parse(readPrivate(marker));
  requireValue(rootMarker.version===1 && rootMarker.backendId==="openclaw" && OP.test(rootMarker.rootId),"MANAGED_HOST_UNKNOWN_DATA_OWNER");
  const adapterRoot=fs.realpathSync(path.join(options.adapterResourcesRoot,"openclaw"));
  requireValue(JSON.stringify(fs.readdirSync(adapterRoot).sort())===JSON.stringify(ADAPTER_FILES),"MANAGED_HOST_ADAPTER_RESOURCE_INVALID");
  const adapterBytes=new Map(ADAPTER_FILES.map(name=>{
    const file=path.join(adapterRoot,name);const s=fs.lstatSync(file);
    requireValue(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o002)===0,"MANAGED_HOST_ADAPTER_RESOURCE_INVALID");
    return [name,fs.readFileSync(file)];
  }));
  const pin=pins.hosts.openclaw;
  const fencePath=path.join(dataRoot,"writer.fence");
  const descriptorPath=path.join(dataRoot,"managed-control.json");
  let writer=null;let fenceFd=null;let fenceStat=null;let fenceNonce=null;let drainLease=null;let state="absent";
  let endpointVerified=false;let modelLease=null;let finishedCredentialLease=null;const tasks=new Set();
  const tracking=async promise=>{tasks.add(promise);try{return await promise;}finally{tasks.delete(promise);}};
  const live=()=>writer && writer.child.exitCode===null && writer.child.signalCode===null && !writer.exited;
  function assertWriter(expected) {
    requireValue(live() && same(expected,writer.identity) && startIdentity(writer.child.pid)===writer.identity.startIdentity,"MANAGED_HOST_WRITER_CHANGED");
  }
  function assertFence(context,cleanup=false) {
    guard(context,cleanup);
    requireValue(fenceFd!==null && fenceNonce===context.nonce,"MANAGED_HOST_FENCE_UNAVAILABLE");
    const actual=fs.lstatSync(fencePath);const held=fs.fstatSync(fenceFd);
    requireValue(actual.dev===fenceStat.dev && actual.ino===fenceStat.ino && held.ino===actual.ino
      && actual.nlink===1 && !actual.isSymbolicLink(),"MANAGED_HOST_FENCE_CHANGED");
    const proof=JSON.parse(readPrivate(fencePath));requireValue(proof.nonce===context.nonce,"MANAGED_HOST_FENCE_CHANGED");
    return {backendId:"openclaw",operationId:context.operationId,dataRoot,exclusive:true,fenceNonce:context.nonce};
  }
  function releaseFence() {
    if(fenceFd===null)return;
    const actual=fs.lstatSync(fencePath);requireValue(actual.dev===fenceStat.dev && actual.ino===fenceStat.ino,"MANAGED_HOST_FENCE_CHANGED");
    fs.closeSync(fenceFd);fenceFd=null;fs.unlinkSync(fencePath);fenceNonce=null;fenceStat=null;
  }
  async function connection(context,cleanup=false) {
    guard(context,cleanup);assertWriter(writer.identity);
    if(writer.connection?.isOpen())return writer.connection;
    const captured=writer;
    const value=await tracking(connect(captured.url,captured.gatewayToken,cleanup?undefined:context.signal,
      Math.min(1000,Math.max(1,context.deadlineAt-Date.now()))));
    try {guard(context,cleanup);assertWriter(captured.identity);captured.connection=value;return value;}
    catch(error){value.close();throw error;}
  }
  async function control(kind,context,cleanup=false,overrides={}) {
    const captured=writer;requireValue(captured,"MANAGED_HOST_WRITER_ABSENT");
    const client=await connection(context,cleanup);guard(context,cleanup);assertWriter(captured.identity);
    const controlDeadlineAt=Math.min(context.deadlineAt,Date.now()+60000);
    const value=await tracking(client.request(`gateway.shoggoth.managed.${kind}`,{
      version:1,controlToken:captured.controlToken,nonce:captured.identity.nonce,operationId:context.operationId,
      deadlineAt:controlDeadlineAt,generation:captured.proof?.generation??null,...overrides
    },{signal:cleanup?undefined:context.signal,timeoutMs:Math.max(1,controlDeadlineAt-Date.now())}));
    guard(context,cleanup);assertWriter(captured.identity);
    requireValue(value?.version===1 && value.protocol==="openclaw-managed-v1" && value.backendId==="openclaw"
      && value.pid===captured.identity.pid && value.nonce===captured.identity.nonce && value.runtimeRoot===captured.runtimeRoot
      && value.runtimeTreeSha256===captured.runtimeTreeSha256 && value.dataRoot===dataRoot && OP.test(value.generation)
      && (!captured.proof || captured.proof.generation===value.generation),"MANAGED_HOST_HEALTH_BINDING_INVALID");
    captured.proof=value;return value;
  }
  const health=(context,proof)=>({backendId:"openclaw",operationId:context.operationId,dataRoot,
    identity:{...writer.identity},runtimeTreeSha256:writer.runtimeTreeSha256,selectionSupported:proof.selectionSupported,
    adapterGeneration:proof.adapterGeneration,paused:proof.paused});
  async function idle(context) {
    while(true) {
      guard(context);
      if(!live())return {backendId:"openclaw",operationId:context.operationId,dataRoot,complete:true,running:0,queued:0};
      const proof=await control("status",context);
      requireValue(proof.paused===true,"MANAGED_HOST_NOT_PAUSED");
      if(proof.snapshot?.idle===true && proof.snapshot.counts?.totalActive===0)
        return {backendId:"openclaw",operationId:context.operationId,dataRoot,complete:true,running:0,queued:0};
      await wait(100,context.signal);
    }
  }
  async function terminateOwned(context,expected,cleanup=false) {
    guard(context,cleanup);assertWriter(expected);const captured=writer;
    captured.connection?.close();captured.connection=null;endpointVerified=false;state="stopping";
    captured.child.kill("SIGTERM");
    while(!captured.exited) {guard(context,cleanup);await wait(50,cleanup?undefined:context.signal);}
    requireValue(writer===captured,"MANAGED_HOST_WRITER_CHANGED");
    writer=null;releaseFence();state="absent";
  }
  const controller={
    async inspectWriter(context) {
      guard(context);
      if(live()) {assertWriter(writer.identity);return {backendId:"openclaw",dataRoot,ownership:"managed",identity:{...writer.identity}};}
      // Neither a persisted descriptor nor a stale lock authorizes adoption.
      if(fenceFd===null && fs.existsSync(fencePath))return {backendId:"openclaw",dataRoot,ownership:"unknown",identity:null};
      if(writer?.exited) {writer.connection?.close();writer=null;releaseFence();state="absent";endpointVerified=false;}
      return {backendId:"openclaw",dataRoot,ownership:"absent",identity:null};
    },
    async acquireDrain(context) {
      guard(context);requireValue(!drainLease,"MANAGED_HOST_DRAIN_HELD");
      if(live()) {const proof=await control("pause",context);requireValue(proof.paused,"MANAGED_HOST_NOT_PAUSED");state="paused";endpointVerified=false;}
      guard(context);
      const nonce=crypto.randomBytes(32).toString("hex");const operation=context.operationId;
      drainLease={operation,nonce,expiresAt:context.deadlineAt+60000};
      return {assertValid:async ctx=>{guard(ctx);requireValue(drainLease?.operation===operation && drainLease.nonce===nonce
        && drainLease.expiresAt>Date.now(),"MANAGED_HOST_DRAIN_INVALID");return {backendId:"openclaw",operationId:operation,dataRoot,leaseNonce:nonce,expiresAt:drainLease.expiresAt};},
        release:async()=>{if(drainLease?.operation===operation&&drainLease.nonce===nonce)drainLease=null;}};
    },
    assertIdle:idle,
    async stopWriter(context) {guard(context);requireValue(context.previousWriter,"MANAGED_HOST_PREVIOUS_WRITER_REQUIRED");
      await idle(context);guard(context);await terminateOwned(context,context.previousWriter);},
    async claimExclusiveDataFence(context) {
      guard(context);requireValue(!live() && fenceFd===null,"MANAGED_HOST_FENCE_HELD");
      fenceFd=fs.openSync(fencePath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
      fenceStat=fs.fstatSync(fenceFd);fenceNonce=context.nonce;
      fs.writeFileSync(fenceFd,JSON.stringify({version:1,nonce:context.nonce,operationId:context.operationId,runtimeRoot:context.candidate.runtimeRoot})+"\n");fs.fsyncSync(fenceFd);
      return {assertValid:async ctx=>assertFence(ctx),release:async()=>{if(!live())releaseFence();}};
    },
    async startPaused(context) {
      guard(context);assertServiceRoot();assertFence(context);requireValue(!live() && context.candidate.backendId==="openclaw"
        && context.candidate.runtimeTreeSha256===pin.outputTreeSha256
        && context.candidate.launch.executable && hashFile(context.candidate.launch.executable)===pin.interpreter.sha256,
      "MANAGED_HOST_CANDIDATE_UNSUPPORTED");
      requireValue(snapshotRuntimeTree(context.candidate.runtimeRoot,{immutable:true}).sha256===pin.outputTreeSha256,
        "MANAGED_HOST_CANDIDATE_CHANGED");guard(context);
      const home=path.join(dataRoot,"home");privateDir(home);const hostState=path.join(dataRoot,"state");privateDir(hostState);
      const workspace=path.join(dataRoot,"workspace");privateDir(workspace);const plugins=path.join(dataRoot,"plugins");privateDir(plugins);
      const adapter=path.join(plugins,ID);privateDir(adapter);
      for(const [name,bytes] of adapterBytes)writePrivateBytes(path.join(adapter,name),bytes);
      const trustPath=path.join(dataRoot,"selection-trust.json");
      writePrivate(trustPath,{version:1,adapterId:ID,sourcePath:path.join(adapter,"index.mjs"),sourceSha256:sha(adapterBytes.get("index.mjs"))});
      const supplied=options.getGatewayConfiguration?.() || {};
      requireValue(supplied && Object.getPrototypeOf(supplied)===Object.prototype
        && Object.keys(supplied).every(key=>["models","agents","tools"].includes(key)),"MANAGED_HOST_CONFIGURATION_INVALID");
      const configPath=path.join(dataRoot,"openclaw.json");
      // Restart reads only this supervisor's canonical owner-only private file.
      // It never borrows the global HOME or overwrites a model transaction with
      // the original constructor's now-stale configuration.
      const prior=fs.existsSync(configPath)?JSON.parse(readPrivate(configPath)):supplied;
      const config=JSON.parse(JSON.stringify(Object.fromEntries(["models","agents","tools","auth","meta"]
        .filter(key=>Object.hasOwn(prior,key)).map(key=>[key,prior[key]]))));
      const port=await freePort();guard(context);assertFence(context);
      const gatewayToken=crypto.randomBytes(32).toString("hex");const controlToken=crypto.randomBytes(32).toString("hex");
      config.agents={...config.agents,defaults:{...config.agents?.defaults,workspace,skipBootstrap:true}};
      config.gateway={mode:"local",port,bind:"loopback",auth:{mode:"token",token:gatewayToken},controlUi:{enabled:true},reload:{mode:"off"}};
      config.logging={level:"info",file:path.join(dataRoot,"gateway.log")};
      config.discovery={mdns:{mode:"off"}};config.update={checkOnStart:false};
      config.plugins={load:{paths:[adapter]},entries:{[ID]:{enabled:true,hooks:{allowConversationAccess:true}}}};
      writePrivate(configPath,config);
      writePrivate(descriptorPath,{version:1,protocol:"openclaw-managed-v1",backendId:"openclaw",nonce:context.nonce,
        operationId:context.operationId,runtimeRoot:context.candidate.runtimeRoot,runtimeTreeSha256:context.candidate.runtimeTreeSha256,dataRoot,controlToken});
      const output=fs.openSync(path.join(dataRoot,"foreground.log"),fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|(fs.constants.O_NOFOLLOW||0),0o600);
      guard(context);assertFence(context);
      const child=spawn(context.candidate.launch.executable,[...context.candidate.launch.args,"gateway","run","--port",String(port),"--auth","token"],
        {cwd:workspace,env:{HOME:home,PATH:`${path.dirname(context.candidate.launch.executable)}:/usr/bin:/bin`,LANG:"en_US.UTF-8",TMPDIR:"/private/tmp",
          USER:process.env.USER||"shoggoth",LOGNAME:process.env.LOGNAME||"shoggoth",OPENCLAW_STATE_DIR:hostState,OPENCLAW_CONFIG_PATH:configPath,
          OPENCLAW_SHOGGOTH_MANAGED_DESCRIPTOR:descriptorPath,OPENCLAW_SELECTION_TRUST_PATH:trustPath,
          SHOGGOTH_SERVICE_USER_DATA_ROOT:assertServiceRoot(),
          OPENCLAW_NO_AUTO_UPDATE:"1",OPENCLAW_DISABLE_BONJOUR:"1"},stdio:["ignore",output,output]});
      fs.closeSync(output);state="starting_paused";endpointVerified=false;
      const captured={child,identity:null,exited:false,url:`ws://127.0.0.1:${port}`,gatewayToken,controlToken,
        runtimeRoot:context.candidate.runtimeRoot,runtimeTreeSha256:context.candidate.runtimeTreeSha256,candidateId:context.candidate.candidateId,
        candidate:context.candidate,connection:null,proof:null};writer=captured;
      captured.execution=Object.freeze({runtimeRoot:captured.runtimeRoot,interpreterPath:context.candidate.launch.executable,
        entryPath:context.candidate.launch.args[0],home,stateDir:hostState,configPath,workspace,
        env:Object.freeze({HOME:home,OPENCLAW_STATE_DIR:hostState,OPENCLAW_CONFIG_PATH:configPath,
          OPENCLAW_SELECTION_TRUST_PATH:trustPath,SHOGGOTH_SERVICE_USER_DATA_ROOT:serviceRoot,
          OPENCLAW_NO_AUTO_UPDATE:"1",OPENCLAW_DISABLE_BONJOUR:"1"})});
      child.once("exit",()=>{captured.exited=true;endpointVerified=false;});
      child.once("error",()=>{captured.exited=true;state="needs_verification";endpointVerified=false;});
      requireValue(child.pid>1,"MANAGED_HOST_SPAWN_FAILED");
      captured.identity={pid:child.pid,startIdentity:startIdentity(child.pid),nonce:context.nonce};
      return {...captured.identity};
    },
    async waitHealthy(context) {
      while(true) {
        guard(context);assertWriter(context.identity);
        try {
          const proof=await control("status",context);
          requireValue(proof.paused===true && proof.operationId===context.operationId && proof.selectionSupported===true
            && OP.test(proof.adapterGeneration) && OP.test(proof.adapterInstanceId),"MANAGED_HOST_SELECTION_UNAVAILABLE");
          state="paused";return health(context,proof);
        } catch(error) {
          guard(context);assertWriter(context.identity);
          if(["MANAGED_HOST_HEALTH_BINDING_INVALID","MANAGED_HOST_SELECTION_UNAVAILABLE"].includes(error.code))throw error;
          await wait(100,context.signal);
        }
      }
    },
    async resume(context) {
      guard(context);assertWriter(context.identity);assertFence(context);
      const proof=await control("resume",context);requireValue(proof.paused===false && proof.operationId===null,"MANAGED_HOST_RESUME_FAILED");
      state="running";endpointVerified=true;return health(context,proof);
    },
    async failClosed(context) {
      if(!live() || !writer.identity || writer.identity.nonce!==context.nonce
        || context.identity && !same(context.identity,writer.identity))return;
      endpointVerified=false;state="needs_verification";
      try {await control("retire",context,true);} catch {}
      await terminateOwned(context,writer.identity,true);
    },
    async abortAndWait(context) {
      endpointVerified=false;
      if(live()) {
        try {await control("retire",context,true);} catch {}
        if(writer.identity?.nonce===context.nonce && (!context.identity || same(context.identity,writer.identity)))
          await terminateOwned(context,writer.identity,true);
      }
      while(tasks.size>0){guard(context,true);await wait(25);}
      return {backendId:"openclaw",operationId:context.operationId,dataRoot,complete:true};
    }
  };
  const MODEL_TTL=120000;
  const modelConfig=()=>{const file=path.join(dataRoot,"openclaw.json"),before=fs.lstatSync(file),bytes=readPrivate(file),after=fs.lstatSync(file);
    requireValue(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size
      &&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'MANAGED_MODEL_CONFIG_SOURCE_MISMATCH');
    const parsed=JSON.parse(bytes);modelPolicy.capture(parsed);return {file,bytes,parsed,hash:sha(bytes),identity:{dev:after.dev,ino:after.ino}};};
  const modelDomainHash=config=>sha(JSON.stringify(modelPolicy.domain(config)));
  const modelBinding=lease=>({token:lease.token,operationId:lease.operationId,requestDigest:lease.requestDigest,
    generation:lease.generation,writerNonce:lease.identity.nonce});
  const sourceRecord=value=>({hash:value.hash,identity:{...value.identity}});
  const ledgerGuard=(lease,context)=>()=>{guard(context);assertWriter(lease.identity);
    assertFence({...context,nonce:lease.identity.nonce});requireValue(modelLease===lease&&writer.proof?.generation===lease.generation,'MANAGED_MODEL_GENERATION_CHANGED');return true;};
  function assertModel(binding,context,{retired=false}={}){
    guard(context);const lease=modelLease;
    requireValue(lease && modelPolicy.equal(binding,modelBinding(lease)) && context.operationId===lease.operationId
      && (retired || !lease.retired && lease.expiresAt>Date.now()),"MANAGED_MODEL_LEASE_INVALID");
    assertWriter(lease.identity);assertFence({...context,nonce:lease.identity.nonce});
    requireValue(writer.proof?.generation===lease.generation,"MANAGED_MODEL_GENERATION_CHANGED");return lease;
  }
  async function modelHealth(lease,context){guard(context);assertWriter(lease.identity);
    const proof=await control("status",context);
    requireValue(proof.modelReadProtocol==='openclaw-model-read-v1' && proof.paused===true && proof.operationId===lease.operationId && proof.selectionSupported===true
      && OP.test(proof.adapterGeneration) && OP.test(proof.adapterInstanceId),"MANAGED_MODEL_HEALTH_UNVERIFIED");
    lease.sourceLedger.assertStaged(modelBinding(lease),sourceRecord(modelConfig()),ledgerGuard(lease,context));
    state="paused";endpointVerified=false;return proof;
  }
  function credentialWriter(lease){return credentialPolicy.credentialOwner({version:1,backendId:'openclaw',operationId:lease.operationId,requestDigest:lease.requestDigest,
    pid:lease.identity.pid,startIdentity:lease.identity.startIdentity,nonce:lease.identity.nonce,generation:lease.generation,
    runtimeRoot:writer.runtimeRoot,runtimeTreeSha256:writer.runtimeTreeSha256,dataRoot,
    interpreterPath:writer.execution.interpreterPath,entryPath:writer.execution.entryPath,expiresAt:lease.expiresAt});}
  function credentialContext(lease,context){return {...context,assertCurrent(){guard(context);assertModel(modelBinding(lease),context);assertServiceRoot();return true;}};}
  const credentialMetadata=response=>modelPolicy.capture(Object.fromEntries(Object.entries(response.envelope).filter(([key])=>!['apiKey','expiresAt'].includes(key))));
  function assertCredentialBound(lease,context){assertModel(modelBinding(lease),context);assertServiceRoot();
    const record=lease.credential;requireValue(record&&credentialSchema.sameCredentialWriter(record.permit.writer,credentialWriter(lease))
      &&record.permit.writer.expiresAt===lease.expiresAt,'MANAGED_MODEL_CREDENTIAL_REBIND_REQUIRED');return record;}
  async function readCredentialMaterial(lease,phase,context){const record=assertCredentialBound(lease,context);
    const material=await credentialChannel.read(record.permit,phase,credentialContext(lease,context),lease.recovery);
    assertCredentialBound(lease,context);const metadata=credentialMetadata(material),key=phase==='previous'?'previous':'candidate';
    requireValue(!record[key]||modelPolicy.equal(record[key],metadata),'MANAGED_MODEL_CREDENTIAL_REVISION_CHANGED');
    record[key]=metadata;return material;}
  async function assertCredentialMaterial(lease,phase,context){const record=assertCredentialBound(lease,context);
    const receipt=await credentialChannel.assert(record.permit,phase,credentialContext(lease,context));assertCredentialBound(lease,context);
    requireValue(record[phase==='previous'?'previous':'candidate']&&modelPolicy.equal(credentialMetadata(receipt),record[phase==='previous'?'previous':'candidate']),
      'MANAGED_MODEL_CREDENTIAL_REVISION_CHANGED');return receipt;}
  async function bindCredential(lease,rawPermit,context){await modelHealth(lease,context);await idle(context);assertModel(modelBinding(lease),context);
    const permit=credentialSchema.credentialPermit(rawPermit),actual=credentialWriter(lease),previous=lease.credential;
    const scopeMatches=permit.scope.api===NATIVE_AUTH_API
      ? modelPolicy.equal(Object.fromEntries(Object.entries(permit.scope).filter(([key])=>!['operationId','requestDigest'].includes(key))),nativeAuthProviderScope(lease.safeSpec,lease.initial))
      : permit.scope.providerKey===lease.safeSpec.providerKey;
    requireValue(scopeMatches&&permit.scope.operationId===lease.operationId&&permit.scope.requestDigest===lease.requestDigest
      &&credentialSchema.sameCredentialWriter(permit.writer,actual)&&permit.writer.expiresAt===actual.expiresAt,'MANAGED_MODEL_CREDENTIAL_OWNER_INVALID');
    if(previous)requireValue(modelPolicy.equal(permit.scope,previous.permit.scope)&&modelPolicy.equal(permit.service,previous.permit.service)
      &&permit.owner.ownerId===previous.permit.owner.ownerId&&!previous.finishGate,'MANAGED_MODEL_CREDENTIAL_OWNER_INVALID');
    const material=await credentialChannel.read(permit,'candidate',credentialContext(lease,context),lease.recovery);assertModel(modelBinding(lease),context);
    const candidate=credentialMetadata(material);
    if(previous)requireValue(modelPolicy.equal(previous.candidate,candidate),'MANAGED_MODEL_CREDENTIAL_REVISION_CHANGED');
    lease.credential={permit,candidate,previous:previous?.previous||null,finishGate:null};return true;}
  async function modelRead(method,params,lease,context){modelPolicy.modelParams(method,params);
    requireValue(method!=="config.patch","MANAGED_MODEL_RPC_UNSUPPORTED");
    await modelHealth(lease,context);guard(context);assertWriter(lease.identity);
    const client=await connection(context);const captured=writer;const deadlineAt=Math.min(context.deadlineAt,Date.now()+60000);
    const receipt=await tracking(client.request('gateway.shoggoth.managed.model.read',{version:1,controlToken:captured.controlToken,nonce:captured.identity.nonce,
      operationId:lease.operationId,deadlineAt,generation:lease.generation,requestDigest:lease.requestDigest,readMethod:method,readParams:params},
      {signal:context.signal,timeoutMs:Math.max(1,deadlineAt-Date.now())}));
    guard(context);assertWriter(lease.identity);const proof=receipt?.proof;
    requireValue(modelPolicy.plain(receipt)&&Object.keys(receipt).length===4&&receipt.requestDigest===lease.requestDigest&&receipt.readMethod===method
      &&proof?.modelReadProtocol==='openclaw-model-read-v1'&&proof.pid===captured.identity.pid&&proof.nonce===captured.identity.nonce
      &&proof.generation===lease.generation&&proof.runtimeRoot===captured.runtimeRoot&&proof.runtimeTreeSha256===captured.runtimeTreeSha256
      &&proof.dataRoot===dataRoot&&proof.paused===true&&proof.operationId===lease.operationId&&proof.selectionSupported===true,'MANAGED_MODEL_READ_PROOF_INVALID');
    captured.proof=proof;
    if(method==='config.get'){
      const local=modelConfig(),binding=modelBinding(lease),current=ledgerGuard(lease,context);
      const loadedRawHash=lease.sourceLedger.loadedHash(binding,sourceRecord(local),current);
      requireValue(receipt.value?.path===local.file&&receipt.value.exists===true&&receipt.value.valid===true,
        'MANAGED_MODEL_CONFIG_SOURCE_MISMATCH');
      const matched=matchesManagedConfigRevision({runtimeRoot:captured.runtimeRoot,dataRoot,
        interpreterPath:captured.execution.interpreterPath,rawHash:loadedRawHash,projectedHash:receipt.value.hash,
        deadlineAt:context.deadlineAt,assertCurrent(){guard(context);assertWriter(lease.identity);
          assertFence({...context,nonce:lease.identity.nonce});requireValue(modelLease===lease&&writer.proof?.generation===lease.generation,'MANAGED_MODEL_GENERATION_CHANGED');}});
      const after=modelConfig();lease.sourceLedger.assertStaged(binding,sourceRecord(after),current);
      requireValue(matched&&after.hash===local.hash&&after.identity.dev===local.identity.dev&&after.identity.ino===local.identity.ino,
        'MANAGED_MODEL_CONFIG_SOURCE_MISMATCH');
      return {exists:true,valid:true,parsed:local.parsed,config:local.parsed,
        raw:local.bytes.toString('utf8'),hash:local.hash,issues:[],warnings:[],
        managedConfigSource:{version:1,persistedRawHash:local.hash,loadedRawHash,loaded:local.hash===loadedRawHash,loadedProjectedHash:receipt.value.hash}};
    }
    lease.sourceLedger.assertStaged(modelBinding(lease),sourceRecord(modelConfig()),ledgerGuard(lease,context));
    return receipt.value;
  }
  async function restartModel(lease,context){
    await modelHealth(lease,context);await idle(context);guard(context);
    const candidate=writer.candidate;const previous={...lease.identity},previousBinding=modelBinding(lease),priorSource=modelConfig();
    lease.sourceLedger.assertStaged(previousBinding,sourceRecord(priorSource),ledgerGuard(lease,context));
    // There is exactly one captured writer. Its exit and fence release precede
    // a new fence and any new child; cancellation is checked after full hashing.
    await terminateOwned(context,previous);guard(context);
    const next={...context,candidate,nonce:crypto.randomBytes(32).toString('hex')};
    try{
      await controller.claimExclusiveDataFence(next);guard(next);
      lease.identity=await controller.startPaused(next);next.identity=lease.identity;
      await controller.waitHealthy(next);guard(next);
    }catch(error){endpointVerified=false;state='needs_verification';if(!live())releaseFence();throw error;}
    lease.generation=writer.proof.generation;const reloaded=modelConfig();
    lease.sourceLedger.replaceLoadedOwner(previousBinding,modelBinding(lease),sourceRecord(priorSource),sourceRecord(reloaded),ledgerGuard(lease,context));
    // A local file ledger is never sufficient for preparation. The actual new
    // paused owner must report the exact new HMAC before catalogue validation.
    await modelRead('config.get',{},lease,context);guard(context);
    lease.loadedDomainHash=modelDomainHash(reloaded.parsed);lease.expiresAt=Date.now()+MODEL_TTL;endpointVerified=false;state='paused';return true;
  }
  function terminalBound(lease,binding,context){
    guard(context);requireValue(modelLease===lease&&modelPolicy.equal(binding,modelBinding(lease)), 'MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
    assertWriter(lease.identity);assertFence({...context,nonce:lease.identity.nonce});assertServiceRoot();
    const record=lease.credential;
    requireValue(record&&record.finishGate&&['applied','compensated','blocked'].includes(record.finishOutcome)
      &&modelPolicy.equal(record.finishBinding,binding)&&record.permit.writer.expiresAt===lease.expiresAt
      &&lease.expiresAt>Date.now()&&writer.proof?.generation===lease.generation,'MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
    requireValue(credentialSchema.sameCredentialWriter(record.permit.writer,credentialWriter(lease)), 'MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
    const local=modelConfig();requireValue(modelPolicy.equal(sourceRecord(local),record.finishSource),'MANAGED_MODEL_CONFIG_SOURCE_MISMATCH');
    lease.sourceLedger.assertStaged(binding,sourceRecord(local),ledgerGuard(lease,context));
    requireValue(lease.sourceLedger.loadedHash(binding,sourceRecord(local),ledgerGuard(lease,context))===local.hash
      &&lease.loadedDomainHash===modelDomainHash(local.parsed),'MANAGED_MODEL_RESTART_REQUIRED');return record;
  }
  async function terminalPauseUnknown(lease){
    endpointVerified=false;const physical={...lease.identity},generation=lease.generation;
    const cleanup={operationId:lease.operationId,nonce:physical.nonce,identity:physical,deadlineAt:Date.now()+10000,signal:new AbortController().signal,
      assertCurrent(){requireValue((modelLease===lease||modelLease===null&&finishedCredentialLease===lease)&&lease.generation===generation,
        'MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');assertWriter(physical);assertFence({operationId:lease.operationId,nonce:physical.nonce,
          deadlineAt:cleanup.deadlineAt,signal:cleanup.signal});}};
    cleanup.assertCurrent();if(modelLease===null)modelLease=lease;
    const proof=await control('pause',cleanup);requireValue(proof.paused===true&&proof.operationId===lease.operationId,'MANAGED_MODEL_TERMINAL_PAUSE_UNVERIFIED');
    state='paused';await idle(cleanup);cleanup.assertCurrent();lease.retired=true;return true;
  }
  const modelController=Object.freeze({
    getOperationId:()=>modelLease?.operationId||null,
    async isSupported(context){
      guard(context);if(!live()||!endpointVerified&&!modelLease)return false;
      const proof=await control('status',context);guard(context);
      return proof.modelReadProtocol==='openclaw-model-read-v1' && proof.selectionSupported===true && modelConfig().parsed.gateway?.reload?.mode==='off'
        &&(proof.paused===false||modelLease&&proof.paused===true&&proof.operationId===modelLease.operationId);
    },
    async recoverCredentialTerminal(binding,context){
      guard(context);const lease=modelLease||finishedCredentialLease;
      requireValue(lease&&modelPolicy.equal(binding,modelBinding(lease))&&context.operationId===lease.operationId,
        'MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
      const record=lease.credential;
      requireValue(record?.finishGate&&!record.recoveryInFlight&&record.finishOutcome&&record.permit.writer.expiresAt>Date.now(),
        'MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
      const physical={...lease.identity};assertWriter(physical);assertFence({...context,nonce:physical.nonce});
      if(modelLease===null)modelLease=lease;
      endpointVerified=false;record.recoveryInFlight=true;
      const bounded={...context,deadlineAt:Math.min(context.deadlineAt,record.permit.writer.expiresAt),assertCurrent(){guard(context);
        terminalBound(lease,binding,context);return true;}};
      try{
        terminalBound(lease,binding,bounded);
        requireValue(snapshotRuntimeTree(writer.runtimeRoot,{immutable:true}).sha256===pin.outputTreeSha256,'MANAGED_HOST_CANDIDATE_CHANGED');
        terminalBound(lease,binding,bounded);
        const expected={candidate:record.candidate,previous:record.previous||null};
        const observe=async writerState=>{
          terminalBound(lease,binding,bounded);
          const receipt=await credentialChannel.observeTerminal(record.permit,record.finishOutcome,writerState,expected,bounded);
          terminalBound(lease,binding,bounded);
          const witness=credentialMetadata(receipt);
          requireValue(!record.terminalWitness||modelPolicy.equal(record.terminalWitness,witness),'MANAGED_MODEL_TERMINAL_BINDING_CHANGED');
          record.terminalWitness=witness;return true;
        };
        const current=await control('status',bounded);terminalBound(lease,binding,bounded);
        requireValue(current.snapshot?.idle===true&&current.snapshot.counts?.totalActive===0,'MANAGED_MODEL_TERMINAL_BUSY');
        if(record.recoveryComplete||record.finishConfirmed){
          requireValue(current.paused===false&&current.operationId===null,'MANAGED_MODEL_TERMINAL_RESUME_UNVERIFIED');
          await observe('resumed');terminalBound(lease,binding,bounded);modelLease=null;endpointVerified=true;state='running';
          return {binding:modelBinding(lease),expiresAt:lease.expiresAt,value:{outcome:record.finishOutcome,paused:false,resumed:true,healthVerified:true}};
        }
        requireValue(!record.recoveryResumeAttempted,'MANAGED_MODEL_TERMINAL_RECOVERY_UNKNOWN');
        if(current.paused===false){requireValue(current.operationId===null,'MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
          await control('pause',bounded);state='paused';}
        await modelHealth(lease,bounded);await idle(bounded);await modelRead('config.get',{},lease,bounded);
        terminalBound(lease,binding,bounded);
        const catalog=lease.nativeConfig?null:await modelRead('models.list',{},lease,bounded),config=modelConfig().parsed;
        if(record.finishOutcome==='applied')requireValue(lease.nativeConfig?modelPolicy.nativeTargetMatches(config,lease.safeSpec,lease.initial):modelPolicy.targetMatches(config,catalog,lease.safeSpec,{retired:true}),'MANAGED_MODEL_TARGET_UNVERIFIED');
        else requireValue(modelPolicy.equal(modelPolicy.domain(config),modelPolicy.domain(lease.initial)),'MANAGED_MODEL_COMPENSATION_UNVERIFIED');
        record.recoveryGate=createManagedProviderTerminalRecoveryGate({
          assertCurrent(){terminalBound(lease,binding,bounded);return true;},observeVerified:observe,
          async resumeVerified(){terminalBound(lease,binding,bounded);
            requireValue(!record.recoveryResumeAttempted,'MANAGED_MODEL_TERMINAL_RECOVERY_UNKNOWN');
            // Original retained record claims the effect synchronously BEFORE dispatch.
            record.recoveryResumeAttempted=true;
            await controller.resume({...bounded,identity:physical,nonce:physical.nonce});
            const proof=await control('status',bounded);terminalBound(lease,binding,bounded);
            requireValue(proof.paused===false&&proof.operationId===null&&proof.snapshot?.idle===true&&proof.snapshot.counts?.totalActive===0,
              'MANAGED_MODEL_TERMINAL_RESUME_UNVERIFIED');return true;},
          pauseVerified:()=>terminalPauseUnknown(lease),
          holdUnverified(verified){lease.retired=true;endpointVerified=false;state=verified?'paused':'needs_verification';}
        });
        await record.recoveryGate.recover();terminalBound(lease,binding,bounded);
        await lease.drain?.release(bounded);lease.drain=null;terminalBound(lease,binding,bounded);
        record.recoveryComplete=true;finishedCredentialLease=lease;modelLease=null;
        return {binding:modelBinding(lease),expiresAt:lease.expiresAt,value:{outcome:record.finishOutcome,paused:false,resumed:true,healthVerified:true}};
      }catch(error){endpointVerified=false;lease.retired=true;
        try{await terminalPauseUnknown(lease);}catch{state='needs_verification';}throw error;
      }finally{record.recoveryInFlight=false;}
    },
    async withdrawCredentialTerminal(binding){
      const lease=modelLease||finishedCredentialLease;
      requireValue(lease&&modelPolicy.equal(binding,modelBinding(lease))&&lease.credential?.finishGate, 'MANAGED_MODEL_TERMINAL_OWNER_UNAVAILABLE');
      lease.credential.finishConfirmed=false;lease.credential.recoveryComplete=false;
      return terminalPauseUnknown(lease);
    },
    async acquire(args,context){
      guard(context);
      const safeSpec=modelPolicy.restoreSpec(args.safeSpec,args.undefinedKeys,args.recovery);
      if(args.recovery){const lease=modelLease;
        requireValue(lease&&args.operationId===lease.operationId&&args.requestDigest===lease.requestDigest&&context.operationId===lease.operationId,'MANAGED_MODEL_RECOVERY_OWNER_UNAVAILABLE');
        requireValue(!lease.credential?.finishGate,'MANAGED_MODEL_TERMINAL_RECOVERY_REQUIRED');
        requireValue(safeSpec.kind===lease.safeSpec.kind&&safeSpec.providerKey===lease.safeSpec.providerKey
          &&safeSpec.sourceModelId===lease.safeSpec.sourceModelId&&(!safeSpec.model||safeSpec.model.id===lease.safeSpec.model?.id),'MANAGED_MODEL_SPEC_MISMATCH');
        for(const[k,v]of Object.entries(safeSpec.model||{}))if(Object.hasOwn(lease.safeSpec.model||{},k))requireValue(modelPolicy.equal(v,lease.safeSpec.model[k]),'MANAGED_MODEL_SPEC_MISMATCH');
        assertWriter(lease.identity);assertFence({...context,nonce:lease.identity.nonce});
        await modelHealth(lease,context);lease.retired=false;lease.recovery=true;lease.clientSpec=safeSpec;lease.expiresAt=Date.now()+MODEL_TTL;
        await modelRead('config.get',{},lease,context);guard(context);return {binding:modelBinding(lease),expiresAt:lease.expiresAt,value:true};
      }
      requireValue(!modelLease && !drainLease && live() && endpointVerified,'MANAGED_MODEL_UNAVAILABLE');
      modelPolicy.digestMatches(safeSpec,args.requestDigest,args.recovery);
      requireValue(context.operationId===args.operationId && modelConfig().parsed.gateway?.reload?.mode==='off',"MANAGED_MODEL_IDENTITY_INVALID");
      const initialSource=modelConfig(),initial=initialSource.parsed;const current=writer;
      const lease={token:crypto.randomBytes(32).toString('hex'),operationId:args.operationId,requestDigest:args.requestDigest,
        safeSpec,clientSpec:safeSpec,recovery:args.recovery,identity:{...current.identity},generation:current.proof.generation,
        expiresAt:Date.now()+MODEL_TTL,initial,loadedDomainHash:modelDomainHash(initial),writes:0,retired:false,drain:null};
      lease.sourceLedger=createManagedConfigSourceLedger(modelBinding(lease),sourceRecord(initialSource));
      finishedCredentialLease=null;modelLease=lease;endpointVerified=false;state='pausing';
      try {lease.drain=await controller.acquireDrain(context);await idle(context);await modelHealth(lease,context);
        await modelRead('config.get',{},lease,context);guard(context);lease.expiresAt=Date.now()+MODEL_TTL;return {binding:modelBinding(lease),expiresAt:lease.expiresAt,value:true};}
      catch(error){lease.retired=true;endpointVerified=false;if(state!=='paused')state='needs_verification';throw error;}
    },
    async action(binding,action,args,context){
      const finalContext=context;const lease=assertModel(binding,context,{retired:action==='abandon'});let value;
      if(action!=='abandon'){
        // Renew/restart/effect continuations are still the original lease. A
        // queued heartbeat cannot make an expired transaction valid retroactively.
        context=modelPolicy.leaseContext(context,lease,()=>modelLease===lease);
      }
      requireValue(!lease.credential?.finishGate||action==='abandon','MANAGED_MODEL_TERMINAL_RECOVERY_REQUIRED');
      switch(action){
        case'assert':await modelHealth(lease,context);value=true;break;
        case'credentialOwner':{
          await modelHealth(lease,context);await idle(context);guard(context);assertModel(binding,context);assertServiceRoot();
          value=credentialWriter(lease);
          break;
        }
        case'credentialBind':value=await bindCredential(lease,args.permit,context);break;
        case'capabilities':await modelHealth(lease,context);value={};break;
        case'idle':await modelHealth(lease,context);await idle(context);value=true;break;
        case'renew':await modelHealth(lease,context);lease.expiresAt=Date.now()+MODEL_TTL;value={expiresAt:lease.expiresAt};break;
        case'rpc':{
          modelPolicy.modelParams(args.method,args.params);
          if(['config.set','models.authSetApiKey','models.authLogout'].includes(args.method)){
            requireValue(!lease.recovery,'MANAGED_MODEL_RECOVERY_WRITE_UNSUPPORTED');
            await modelHealth(lease,context);await idle(context);guard(context);const before=modelConfig();
            lease.sourceLedger.assertStaged(modelBinding(lease),sourceRecord(before),ledgerGuard(lease,context));
            let params,material=null;
            if(args.method==='config.set'){
              requireValue(before.hash===args.params.baseHash,'MANAGED_MODEL_CONFIG_CONFLICT');
              const submitted=JSON.parse(args.params.raw);credentialEffect.assertNoWireSecrets(submitted);
              const next=modelPolicy.validateNativeDraft(before.parsed,submitted,lease.safeSpec);
              params={raw:JSON.stringify(next),baseHash:before.hash};
            }else{
              requireValue(args.params.provider===(lease.safeSpec.patch?.renameTo||lease.safeSpec.providerKey),'MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND');
              requireValue(args.params.agentId===resolveNativeAuthAgent(lease.safeSpec,lease.initial)
                &&args.params.credentialScope===lease.safeSpec.credentialScope
                &&lease.credential?.permit.scope.api===NATIVE_AUTH_API,'MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND');
              material=await readCredentialMaterial(lease,'candidate',context);
              await assertCredentialMaterial(lease,'candidate',context);
              const action=args.method==='models.authLogout'?'clear':'set';
              requireValue(material.envelope.action===action&&material.envelope.expiresAt>Date.now(),'MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND');
              params={provider:args.params.provider,agentId:args.params.agentId,
                ...(lease.safeSpec.credentialScope==='provider'?{credentialScope:'provider',agentIds:nativeAuthAgentIds(lease.initial),
                  configuredConnection:Object.keys(before.parsed.models?.providers||{}).some(key=>key.toLowerCase()===args.params.provider.toLowerCase())}:{}),
                ...(action==='clear'?{credentialType:'api_key'}:{apiKey:material.envelope.apiKey})};
            }
            lease.nativeConfig=true;
            let result;
            try{result=await tracking(runNativeModelMethod({runtimeRoot:writer.runtimeRoot,dataRoot,execution:writer.execution,
              method:args.method,params,deadlineAt:context.deadlineAt,signal:context.signal,
              assertCurrent(){guard(context);assertModel(modelBinding(lease),context);return true;}}));}
            catch(error){
              if(args.method==='config.set'&&error.gatewayResponse===true&&error.code==='INVALID_REQUEST'){
                const unchanged=modelConfig();
                requireValue(unchanged.hash===before.hash&&unchanged.identity.dev===before.identity.dev&&unchanged.identity.ino===before.identity.ino,
                  'MANAGED_NATIVE_OUTCOME_UNKNOWN');
                value={ok:false,noWrite:true,code:'config_rejected',hash:before.hash};break;
              }
              throw error;
            }finally{params=null;material=null;}
            guard(context);assertModel(modelBinding(lease),context);const persisted=modelConfig();
            if(args.method!=='config.set'){
              requireValue(result?.provider?.toLowerCase()===args.params.provider.toLowerCase(),'MANAGED_MODEL_CREDENTIAL_RECEIPT_INVALID');
              modelPolicy.validateNativeAuthMutation(before.parsed,persisted.parsed,args.params.provider,result);
              lease.nativeCredentialReceipt=modelPolicy.capture(result);
            }
            lease.sourceLedger.recordStagedWrite(modelBinding(lease),sourceRecord(before),sourceRecord(persisted),ledgerGuard(lease,context));
            lease.writes+=1;
            value=args.method==='config.set'?{ok:true,hash:persisted.hash,restartRequired:true}:result;break;
          }
          if(args.method!=='config.patch'){value=await modelRead(args.method,args.params,lease,context);break;}
          requireValue(!lease.recovery,"MANAGED_MODEL_RECOVERY_WRITE_UNSUPPORTED");
          await modelHealth(lease,context);await idle(context);guard(context);const before=modelConfig();
          lease.sourceLedger.assertStaged(modelBinding(lease),sourceRecord(before),ledgerGuard(lease,context));
          requireValue(before.hash===args.params.baseHash,"MANAGED_MODEL_CONFIG_CONFLICT");
          const patch=JSON.parse(args.params.raw);modelPolicy.capture(patch);credentialEffect.assertNoWireSecrets(patch);
          requireValue(modelPolicy.plain(patch)&&Object.keys(patch).every(k=>['models','agents'].includes(k)),"MANAGED_MODEL_OWNED_CONFIG_CHANGED");
          // Import the exact immutable pinned Host's merge implementation. This
          // preserves its ID-array/replacePaths semantics without a broad RPC.
          const merge=await import(pathToFileURL(path.join(writer.runtimeRoot,'dist/merge-patch-CzMe99iw.mjs')).href);
          assertModel(binding,context);let after=merge.t(before.parsed,patch,{mergeObjectArraysById:true,replaceArrayPaths:new Set(args.params.replacePaths)});
          if(Object.hasOwn(args,'credentialPhase')){
            const phase=credentialSchema.credentialRpcOptions('config.patch',{credentialPhase:args.credentialPhase}).credentialPhase;
            let material=null,previousMaterial=null;
            try{material=await readCredentialMaterial(lease,phase,context);
              if(phase==='candidate'&&material.envelope.action==='preserve')previousMaterial=await readCredentialMaterial(lease,'previous',context);
              after=credentialEffect.applyCredentialPatch({before:before.parsed,after,initial:lease.initial,safeSpec:lease.safeSpec,
                permit:lease.credential.permit,phase,response:material,previousResponse:previousMaterial});
              await assertCredentialMaterial(lease,phase,context);
              if(previousMaterial)await assertCredentialMaterial(lease,'previous',context);
              requireValue(material.envelope.expiresAt>Date.now()&&(!previousMaterial||previousMaterial.envelope.expiresAt>Date.now()),
                'MANAGED_MODEL_CREDENTIAL_MATERIAL_EXPIRED');
            }finally{material=null;previousMaterial=null;}
          }else credentialEffect.validateMetadataPatch(before.parsed,after,lease.safeSpec,lease.initial);
          lease.sourceLedger.assertStaged(modelBinding(lease),sourceRecord(modelConfig()),ledgerGuard(lease,context));
          requireValue(modelConfig().hash===before.hash,"MANAGED_MODEL_CONFIG_CONFLICT");guard(context);
          assertModel(binding,context);writePrivate(before.file,after);const persisted=modelConfig();
          lease.sourceLedger.recordStagedWrite(modelBinding(lease),sourceRecord(before),sourceRecord(persisted),ledgerGuard(lease,context));
          lease.writes+=1;value={ok:true,hash:persisted.hash,restartRequired:true};break;
        }
        case'restart':value=await restartModel(lease,context);break;
        case'healthy':await modelHealth(lease,context);value=true;break;
        case'verify':case'converge':{
          requireValue(modelPolicy.equal(args.safeSpec,JSON.parse(JSON.stringify(lease.clientSpec))),"MANAGED_MODEL_SPEC_MISMATCH");
          if(action==='converge'&&lease.loadedDomainHash!==modelDomainHash(modelConfig().parsed))await restartModel(lease,context);
          await modelHealth(lease,context);const config=modelConfig().parsed;
          requireValue(lease.loadedDomainHash===modelDomainHash(config),"MANAGED_MODEL_RESTART_REQUIRED");
          if(lease.nativeConfig)requireValue(modelPolicy.nativeTargetMatches(config,lease.safeSpec,lease.initial),"MANAGED_MODEL_TARGET_UNVERIFIED");
          else{const catalog=await modelRead('models.list',{},lease,context);
            requireValue(modelPolicy.targetMatches(config,catalog,lease.safeSpec,{retired:action==='converge'}),"MANAGED_MODEL_TARGET_UNVERIFIED");}value=true;break;
        }
        case'finish':{
          requireValue(modelPolicy.equal(args.safeSpec,JSON.parse(JSON.stringify(lease.clientSpec)))&&['applied','compensated','blocked'].includes(args.outcome),"MANAGED_MODEL_OUTCOME_UNVERIFIED");
          if(args.outcome==='blocked')requireValue(lease.writes===0,"MANAGED_MODEL_BLOCKED_AFTER_WRITE");
          if(args.outcome!=='applied')requireValue(modelPolicy.equal(modelPolicy.domain(modelConfig().parsed),modelPolicy.domain(lease.initial)),"MANAGED_MODEL_COMPENSATION_UNVERIFIED");
          if(lease.loadedDomainHash!==modelDomainHash(modelConfig().parsed)){
            requireValue(!lease.credential,'MANAGED_MODEL_CREDENTIAL_RESTART_REQUIRED');await restartModel(lease,context);}
          await modelHealth(lease,context);await idle(context);const config=modelConfig().parsed;
          const catalog=lease.nativeConfig?null:await modelRead('models.list',{},lease,context);
          if(args.outcome==='applied')requireValue(lease.nativeConfig?modelPolicy.nativeTargetMatches(config,lease.safeSpec,lease.initial):modelPolicy.targetMatches(config,catalog,lease.safeSpec,{retired:true}),"MANAGED_MODEL_TARGET_UNVERIFIED");
          else for(const[key,provider]of Object.entries(config.models?.providers||{}))for(const m of provider.models||[])
            requireValue(lease.nativeConfig||(catalog.models||[]).some(row=>row.id===key+'/'+m.id||row.provider===key&&row.id===m.id),"MANAGED_MODEL_COMPENSATION_UNVERIFIED");
          lease.sourceLedger.assertStaged(modelBinding(lease),sourceRecord(modelConfig()),ledgerGuard(lease,context));
          if(lease.credential){const record=assertCredentialBound(lease,context);
            requireValue(!record.finishGate,'MANAGED_MODEL_CREDENTIAL_FINISH_UNKNOWN');
            const phase=args.outcome==='applied'?'candidate':'previous';
            if(phase==='previous'){const previousMaterial=await readCredentialMaterial(lease,'previous',context);
              if(!lease.nativeConfig)credentialEffect.applyCredentialPatch({before:modelConfig().parsed,after:modelConfig().parsed,initial:lease.initial,safeSpec:lease.safeSpec,
                permit:record.permit,phase:'previous',response:previousMaterial});}
            await assertCredentialMaterial(lease,phase,context);
            const physical={...lease.identity},generation=lease.generation;
            record.finishOutcome=args.outcome;record.finishBinding=modelPolicy.capture(modelBinding(lease));record.finishSource=modelPolicy.capture(sourceRecord(modelConfig()));
            record.finishGate=createManagedProviderCredentialFinishGate({
              assertCurrent(){guard(context);assertCredentialBound(lease,context);return true;},
              async resumeVerified(){await controller.resume({...context,identity:physical,nonce:physical.nonce});
                const proof=await control('status',context);requireValue(proof.paused===false&&proof.operationId===null&&proof.selectionSupported===true
                  &&proof.modelReadProtocol==='openclaw-model-read-v1','MANAGED_MODEL_CREDENTIAL_RESUME_UNVERIFIED');return true;},
              async settleVerified(outcome){const receipt=await credentialChannel.settle(record.permit,outcome,credentialContext(lease,context));
                assertCredentialBound(lease,context);requireValue(receipt.envelope.state===outcome,'MANAGED_MODEL_CREDENTIAL_OUTCOME_INVALID');
                await lease.drain?.release(context);lease.drain=null;return true;},
              async pauseVerified(){endpointVerified=false;const cleanup={operationId:lease.operationId,nonce:physical.nonce,identity:physical,
                  deadlineAt:Date.now()+10000,signal:new AbortController().signal,
                  assertCurrent(){requireValue(modelLease===lease&&lease.generation===generation,'MANAGED_MODEL_CREDENTIAL_OWNER_INVALID');
                    assertWriter(physical);assertFence({operationId:lease.operationId,nonce:physical.nonce,
                      deadlineAt:cleanup.deadlineAt,signal:cleanup.signal});}};
                cleanup.assertCurrent();const proof=await control('pause',cleanup);requireValue(proof.paused===true&&proof.operationId===lease.operationId,'MANAGED_MODEL_CREDENTIAL_PAUSE_UNVERIFIED');
                state='paused';await idle(cleanup);cleanup.assertCurrent();return true;},
              holdUnverified(verified){endpointVerified=false;lease.retired=true;state=verified?'paused':'needs_verification';}
            });
            await record.finishGate.finish(args.outcome);
            try{guard(finalContext);assertCredentialBound(lease,context);}catch{await record.finishGate.withdraw();throw fail('MANAGED_MODEL_CREDENTIAL_FINISH_UNKNOWN');}
          }else{assertModel(modelBinding(lease),context);await controller.resume({...context,identity:lease.identity,nonce:lease.identity.nonce});
            await lease.drain?.release(context);}
          if(lease.credential){lease.credential.finishConfirmed=true;finishedCredentialLease=lease;}modelLease=null;value={paused:false,resumed:true,healthVerified:true};break;
        }
        case'abandon':lease.retired=true;endpointVerified=false;await modelHealth(lease,context);
          if(!lease.credential?.finishGate)lease.expiresAt=Date.now()+MODEL_TTL;value={paused:true,resumed:false};break;
        default:throw fail('MANAGED_MODEL_ACTION_INVALID');
      }
      try{guard(finalContext);}catch(error){
        // The same command can be canceled after the confirmed physical effect
        // but before publication. Withdraw only that retained original writer.
        if(action==='finish'&&lease.credential&&finishedCredentialLease===lease){
          lease.credential.finishConfirmed=false;lease.credential.recoveryComplete=false;
          try{await terminalPauseUnknown(lease);}catch{state='needs_verification';}
        }
        throw error;
      }
      if(modelLease===lease)assertModel(modelBinding(lease),context,{retired:action==='abandon'});
      return {binding:modelBinding(lease),expiresAt:lease.expiresAt,value};
    },
    async retireForStop(){if(!modelLease)return null;const lease=modelLease;lease.retired=true;endpointVerified=false;
      await lease.drain?.release();lease.drain=null;return lease.operationId;},
  });
  function getStatus() {
    const ownership=live()?"managed":fs.existsSync(fencePath)?"unknown":"absent";
    return Object.freeze({backendId:"openclaw",state:ownership==="unknown"?"unknown_writer":state,ownership,dataRoot,
      identity:live()&&writer.identity?Object.freeze({...writer.identity}):null,runtimeRoot:writer?.runtimeRoot||null,
      candidateId:writer?.candidateId||null,generation:writer?.proof?.generation||null,
      selectionSupported:writer?.proof?.selectionSupported===true,adapterGeneration:writer?.proof?.adapterGeneration||null,
      adapterInstanceId:writer?.proof?.adapterInstanceId||null,counts:writer?.proof?.snapshot?.counts||null});
  }
  return Object.freeze({controller:Object.freeze(controller),modelController,activationAuthority:createManagedHostRuntimeAuthority(controller),getStatus,
    getEndpoint:()=>endpointVerified&&live()?Object.freeze({url:writer.url,token:writer.gatewayToken,identity:Object.freeze({...writer.identity}),dataRoot,
      runtimeRoot:writer.runtimeRoot,interpreterPath:writer.execution.interpreterPath,entryPath:writer.execution.entryPath}):null,
    getExecution:()=>endpointVerified&&live()?writer.execution:null,
    async request(method,params={},requestOptions={}) {
      requireValue(!modelLease && endpointVerified&&live(),"MANAGED_HOST_ENDPOINT_UNVERIFIED");
      const context={operationId:`read-${crypto.randomUUID()}`,deadlineAt:Date.now()+Math.min(60000,requestOptions.timeoutMs||15000),signal:requestOptions.signal};
      const client=await connection(context);return client.request(method,params,requestOptions);
    },
    async stopOwned({operationId=`stop-${crypto.randomUUID()}`,timeoutMs=15000}={}) {
      requireValue(OP.test(operationId) && Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000,"MANAGED_HOST_STOP_INVALID");
      operationId=await modelController.retireForStop() || operationId;
      const context={backendId:"openclaw",operationId,nonce:writer?.identity?.nonce,
        deadlineAt:Date.now()+timeoutMs,signal:new AbortController().signal,assertCurrent(){}};
      const owner=await controller.inspectWriter(context);
      requireValue(owner.ownership!=="unknown","MANAGED_HOST_WRITER_OWNER_UNKNOWN");if(owner.ownership==="absent"){modelLease=null;finishedCredentialLease=null;return getStatus();}
      context.previousWriter=owner.identity;const lease=await controller.acquireDrain(context);
      try {await controller.assertIdle(context);await controller.stopWriter(context);} finally {await lease.release(context);}
      modelLease=null;return getStatus();
    }
  });
}
function writePrivateBytes(file,bytes) {
  if(fs.existsSync(file))requireValue(sha(readPrivate(file))===sha(bytes),"MANAGED_HOST_ADAPTER_CHANGED");
  else {const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
    try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
}
module.exports={createManagedOpenClawHostSupervisor};
