#!/usr/bin/env node
"use strict";
// Actual Source WorkRun and pinned SDK metadata probe. The original turn/start
// RPC is never submitted; the failed WorkRun is an intentional stopping point.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const worker=require("./group-collaboration-live-worker.cjs"),matrix=require("./group-collaboration-live-matrix.cjs");
const arg=new Map();for(let i=2;i<process.argv.length;i+=2){assert(["--sourceRepo","--codexDefaults","--output"].includes(process.argv[i]));assert(!arg.has(process.argv[i]));arg.set(process.argv[i],process.argv[i+1]);}
const source=fs.realpathSync(arg.get("--sourceRepo")),output=arg.get("--output"),metadataFile=arg.get("--codexDefaults");
assert(output&&path.dirname(output)==="/private/tmp"&&!fs.existsSync(output));
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex"),sourceModule=file=>require(path.join(source,file));
const sourceBefore=worker.metadata(source),defaults=require("./group-collaboration-codex-defaults.cjs").load(metadataFile,{sdkVersion:sourceModule("app/agent-service/codex-schema-contract").CODEX_VERSION});
const root=fs.realpathSync(fs.mkdtempSync("/private/tmp/sggroup-live-"));fs.chmodSync(root,0o700);
const work=path.join(root,"workspace");fs.mkdirSync(work,{mode:0o700});
const {resolveServicePaths}=sourceModule("app/agent-service/paths"),paths=resolveServicePaths({homeDir:root});
const {createAgentService,PROTOCOL_VERSION}=sourceModule("app/agent-service/server"),{requestService,readClientToken}=sourceModule("app/agent-service/client");
const {RuntimeMcpGateIssuer}=sourceModule("app/agent-service/runtime-mcp-gate");
const accounts=sourceModule("app/agent-service/runtime-account"),key=crypto.randomBytes(32);
fs.writeFileSync(path.join(root,"mcp-key.bin"),key,{flag:"wx",mode:0o600});
const bootstrap=worker.writeHelper(root,source),mcpHelperLaunch={command:fs.realpathSync(process.execPath),argsPrefix:[bootstrap]};
const main=path.join(os.homedir(),"Documents/claude/Shoggoth"),pin=sourceModule("app/agent-service/codex-runtime-paths").resolveCodexRuntimeLayout({repoRoot:main});
const pinnedFixture=fs.readFileSync(path.join(main,"scripts/codex-mcp-tool-call-native-fixture.cjs"),"utf8"),expectedPin=/EXPECTED_BINARY_SHA\s*=\s*'([a-f0-9]{64})'/u.exec(pinnedFixture)?.[1];
assert(expectedPin&&sha(fs.readFileSync(pin.runtimePath))===expectedPin);assert.equal(pin.version,sourceModule("app/agent-service/codex-schema-contract").CODEX_VERSION);
const env={...process.env,HOME:os.homedir(),TMPDIR:root};
const service=createAgentService({paths,repoRoot:source,version:"codex-source-pre-model-metadata",parentEnv:env,runtimeStorageHomedir:os.homedir(),
  builtinCliProfiles:false,prewarmMcpAuth:false,safeStorage:worker.makeSafeStorage(key),mcpHelperLaunch,
  runtimeMcpGateIssuer:new RuntimeMcpGateIssuer({paths,mcpHelperLaunch,bootstrapPath:bootstrap})});
const layout=worker.bindOwnedCodexSdkLayout({service,sourceRepo:source,selectedBinary:pin.runtimePath});
const nativeFiles=[path.join(os.homedir(),".codex/config.toml"),path.join(os.homedir(),".codex/auth.json"),path.join(os.homedir(),".codex/AGENTS.md"),path.join(os.homedir(),"AGENTS.md")];
const fileObservation=()=>Object.fromEntries(nativeFiles.map(file=>{try{const stat=fs.lstatSync(file);return[file,{availability:"lstat-only;content-not-read",contentNotRead:true,regular:stat.isFile(),symlink:stat.isSymbolicLink(),bytes:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,mode:stat.mode&0o777}];}catch(error){return[file,{availability:error.code==="ENOENT"?"missing":"unavailable",contentNotRead:true}];}}));
const modules=["codex-group-worker-metadata-zero-provider.cjs","group-collaboration-live-worker.cjs","group-collaboration-live-matrix.cjs","group-collaboration-live-external.cjs","group-collaboration-live-policy.cjs","codex-owned-permissions-fixture.cjs","group-collaboration-codex-defaults.cjs"];
const moduleHashes=()=>Object.fromEntries(modules.map(name=>[name,sha(fs.readFileSync(path.join(__dirname,name)))]));
const report={version:1,coverage:"actual Source Service/WorkRun/NativeCodexAuth/pinned SDK metadata/MCP gate; intentional failed WorkRun before original turn/start RPC; no completed model claim",startedAt:new Date().toISOString(),root,
 source:sourceBefore,sourceVersion:"baseline-pre-model-probe",pinnedBinary:{path:pin.runtimePath,version:pin.version,sha256:expectedPin},moduleHashesBefore:moduleHashes(),codexNativeDefaults:defaults,codexSdkLayout:layout,
 codexAuthority:{method:"unchanged-production-NativeCodexAuth-reader-and-owned-internal-managed-runtime",sourceRuntimeAccountId:accounts.NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
 executionRuntimeAccountId:accounts.SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,authoritySemantics:"same-native-chatgpt-account-borrowed-in-memory;managed-account-identifies-execution-home-only",nativeReaderRpc:[],reads:[],accountIdentitySha256:null,credentialsExported:false},
 originalNativeBefore:fileObservation(),providerCalls:0,providerCallProof:"original SDK generation turn/start RPC is physically intercepted before submission; metadata/auth HTTP is separate and uncounted",
 originalTurnStartRpcSubmitted:0,mainWireMethods:[],interceptedTurnStart:[],serviceStopped:false};
let observer,undoRuntime,fixtureFactoryRestore,profiles=[],failure;
const call=(method,params)=>requestService(paths,{token:readClientToken(paths),version:PROTOCOL_VERSION,method,params},{timeoutMs:15000});
(async()=>{try{
 await service.start();const base=service.productStore.listAgentProfiles()[0];
 profiles=["reader","observer"].map(name=>{const workspace=path.join(work,name);fs.mkdirSync(workspace,{mode:0o700});const profile=worker.configureProfile(service,base,"codex",accounts.SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,workspace,"Metadata "+name,defaults.config.model);
  const current=service.agentDefinitionStore.get(profile.id);service.agentDefinitionStore.update({profileId:profile.id,expectedRevision:current.manifest.revision,documents:{IDENTITY:"# IDENTITY\n\nSynthetic metadata probe only.\n",SOUL:"# SOUL\n\nSynthetic metadata probe only.\n"},actor:"user",reason:"owned zero-provider metadata preflight"});return profile;});
 worker.installOwnedNativeToolPolicies({service,root,profiles,sourceRepo:source,caseId:"simple-fact",result:report,codexDefaults:defaults});
 observer=worker.observeOwnedNativeProcesses({service,profiles,result:report});undoRuntime=matrix.observeRuntime(service,report);
 const factory=service.runtimePool.hostFactory;const interceptedFactory=function(options){const host=factory.call(this,options),request=host._request,initialize=host.initialize;
  host.initialize=async function(...args){const initialized=await initialize.apply(this,args),wire=this.rpc.request;this.rpc.request=function(method,params,...rest){report.mainWireMethods.push({method,threadId:typeof params?.threadId==="string"?params.threadId:null});if(method==="turn/start"){report.originalTurnStartRpcSubmitted++;throw Object.assign(new Error("FORBIDDEN_GENERATION_RPC"),{code:"GROUP_CODEX_PREFLIGHT_GENERATION_RPC_FORBIDDEN"});}return wire.call(this,method,params,...rest);};return initialized;};
  host._request=function(method,params,...rest){if(method==="turnStart"){report.interceptedTurnStart.push({runtimeProfileId:options.runtimeProfileId,threadId:params.threadId,model:params.model,effort:params.effort,serviceTier:params.serviceTier,cwd:params.cwd,actualOriginalRpcSubmitted:false});throw Object.assign(new Error("GROUP_CODEX_PRE_MODEL_PREFLIGHT_STOP"),{code:"GROUP_CODEX_PRE_MODEL_PREFLIGHT_STOP"});}return request.call(this,method,params,...rest);};return host;};
 service.runtimePool.hostFactory=interceptedFactory;fixtureFactoryRestore=()=>{if(service.runtimePool.hostFactory!==interceptedFactory)throw Object.assign(new Error("OBSERVER_CHANGED"),{code:"GROUP_LIVE_NATIVE_PROCESS_OBSERVER_CHANGED"});service.runtimePool.hostFactory=factory;};
 const group=await call("group.create",{operationId:"metadata-group-create",name:"Owned Codex metadata",purpose:"No generation RPC",members:profiles.map(profile=>({backendId:"shoggoth",agentId:profile.agentId}))});
 const target=group.members.find(member=>member.agentId===profiles[0].agentId);
 await call("group.send",{groupId:group.group.id,clientMessageId:"owned-pre-model-probe",body:"仅合成元数据预检：读取被授权的群上下文。本预检在原 turn/start RPC 前停止，不要求生成回答。",mentions:[target.id],replyTo:null,attachments:[]});
 const deadline=Date.now()+90000;
 do{const runs=service.workRunCoordinator.listRuns().filter(run=>profiles.some(profile=>profile.id===run.profileId));
  if(runs.length&&runs.every(run=>["failed","canceled","completed","interrupted"].includes(run.status))){report.workRuns=runs.map(run=>({id:run.id,profileId:run.profileId,status:run.status,errorCode:run.errorCode??null,runtimeSessionRef:run.runtimeSessionRef??null,runtimeTurnRef:run.runtimeTurnRef??null}));break;}
  await new Promise(resolve=>setTimeout(resolve,100));
 }while(Date.now()<deadline);
 assert(report.workRuns?.length,"owned Source WorkRun reached terminal state");assert(report.interceptedTurnStart.length>0,"metadata path reached guarded original turn boundary");
 assert(report.workRuns.every(run=>run.status==="failed"));
 report.expectedStop={originalCause:"GROUP_CODEX_PRE_MODEL_PREFLIGHT_STOP",actualWorkRunErrorCodes:report.workRuns.map(run=>run.errorCode),originalSdkTurnRpcNeverCalled:true,workRunsRemainFailed:true};
 assert(report.toolEnvironment.runtimes.some(row=>row.runtime==="codex"&&row.actualRuntimeVerified));assert(report.codexAuthority.accountIdentitySha256);
 report.status="metadata-verified-before-expected-model-stop";
}catch(error){failure=error;report.status="failed";report.errorCode=/^[A-Z][A-Z0-9_]{0,100}$/u.test(error.code||"")?error.code:"GROUP_CODEX_METADATA_PREFLIGHT_FAILED";report.assertion=error.name==="AssertionError"?error.message:null;}
finally{
 const capture=path.join(root,"helper-observations.jsonl");report.helperObservations=fs.existsSync(capture)?fs.readFileSync(capture,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse):[];
 report.nativeOwnedProcessSnapshot=observer?.snapshot()??null;report.serviceStop=await worker.boundedStop(()=>service.stop({notify:false}));
 // Restore only the outer fixture interception, leaving observer restoration exact.
 fixtureFactoryRestore?.();
 try{report.nativeStop=observer?await observer.finish():null;}catch(error){report.nativeStop={stopped:false,errorCode:error.code??"SOURCE_OBSERVER_RESTORE_FAILED"};}
 report.serviceStopped=report.serviceStop.stopped&&report.nativeStop?.stopped===true;undoRuntime?.();key.fill(0);
 report.originalNativeAfter=fileObservation();report.originalNativeObservation="lstat metadata only; auth.json and AGENTS bytes were not read; SDK native cache/auth refresh metadata changes, if any, are preserved and separately reported; no original user process stopped";
 worker.finishCodexObservation(report,defaults);worker.observeFrozenSource(report,sourceBefore);report.moduleHashesAfter=moduleHashes();report.modulesUnchanged=JSON.stringify(report.moduleHashesBefore)===JSON.stringify(report.moduleHashesAfter);
 report.pinnedBinaryUnchanged=sha(fs.readFileSync(pin.runtimePath))===expectedPin;
 report.finishedAt=new Date().toISOString();report.pass=!failure&&!report.errorCode&&report.status==="metadata-verified-before-expected-model-stop"
  &&report.serviceStopped&&report.sourceUnchanged&&report.modulesUnchanged&&report.pinnedBinaryUnchanged
  &&Object.values(report.codexDefaultsFinalObservation).every(value=>value===true)
  &&Array.isArray(report.codexManagedHomeAuthFileObservation)&&report.codexManagedHomeAuthFileObservation.length>0
  &&report.codexManagedHomeAuthFileObservation.every(row=>row.authFileAbsent===true)&&report.originalTurnStartRpcSubmitted===0;
 fs.writeFileSync(output,JSON.stringify(matrix.safeEvidence(report),null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify({output,root,pass:report.pass,status:report.status,errorCode:report.errorCode??null,providerCalls:report.providerCalls,interceptedTurnStarts:report.interceptedTurnStart.length,serviceStopped:report.serviceStopped}));process.exitCode=report.pass?0:1;
}})();
