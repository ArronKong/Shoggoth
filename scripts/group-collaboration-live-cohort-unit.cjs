#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const cohort=require("./group-collaboration-live-cohort.cjs"),matrix=require("./group-collaboration-live-matrix.cjs"),worker=require("./group-collaboration-live-worker.cjs"),policy=require("./group-collaboration-live-policy.cjs");
const root=fs.mkdtempSync("/private/tmp/sggroup-live-cohort-unit-");fs.chmodSync(root,0o700);
const descriptorBytes=fs.readFileSync(path.join(__dirname,"fixtures/group-collaboration-live-evaluation.json")),descriptor=JSON.parse(descriptorBytes),sha=value=>crypto.createHash("sha256").update(value).digest("hex"),descriptorSha256=sha(descriptorBytes);
const descriptorFile=path.join(root,"descriptor.json");fs.writeFileSync(descriptorFile,descriptorBytes,{mode:0o600});
const tests=[],test=(name,fn)=>tests.push({name,fn}),rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);
const groups=key=>{const i=key.lastIndexOf("/");return[key.slice(0,i),Number(key.slice(i+1))];};
function report(slot){return{reportVersion:2,status:"failed",errorCode:"SYNTHETIC_BUSINESS_FAILURE_FIXTURE",evaluation:{sourceVersion:"baseline",descriptorSha256,...slot},source:{gitSha:descriptor.sourcePolicy.baselineGit,sourceDigest:"a".repeat(64)},sourceUnchanged:true,workerUnchanged:true,runtimeBinaryUnchanged:true,descriptorUnchanged:true,externalStopped:true,serviceStopped:true,durationMs:1000,stateTrajectories:[{actualFixture:true}],runOutcomes:[],finalMessages:[],tasks:[],groupOutcomes:{requests:[]},requests:[],usageAvailability:{providerRequestCount:null},guardEnvironmentFingerprint:"b".repeat(64),effectiveModelEvidence:null,toolEnvironment:{runtimes:[{groupTools:cohort.BASELINE_TOOLS}]}};}
function files(key){const[groupId,round]=groups(key);return descriptor.cases.map(sample=>{const slot=cohort.facts(descriptor,groupId,round,sample.id),file=path.join(root,groupId+"-"+round+"-"+sample.id+".json");fs.writeFileSync(file,JSON.stringify(report(slot)),{mode:0o600});return file;});}
const first=files("native-external/1"),thresholds={quality:{allCriticalFactsRequired:true},comparison:"synthetic unit fixture only;no-model-report"};
let manifest;
test("partial cohort freezes a complete original eight-case group/round without claiming 32 or 72 completion",()=>{
 manifest=cohort.freeze({descriptor,descriptorSha256,baselineReportPaths:first,thresholds});assert.equal(manifest.baselineComplete,false);assert.equal(manifest.overallMatrixComplete,false);assert.equal(manifest.partialCohort.slotCount,8);assert.equal(manifest.partialCohort.expectedAvailableSlots,32);assert.equal(manifest.partialCohort.expectedMatrixSlots,72);
 assert.equal(manifest.partialCohort.slots[0].observation.status,"failed");assert.equal(manifest.partialCohort.slots[0].observation.providerRequestCount,null);
 const file=path.join(root,"thresholds.json");fs.writeFileSync(file,JSON.stringify(manifest),{mode:0o600});
 const evaluated=matrix.evaluation({descriptor:descriptorFile,sourceVersion:"candidate",thresholds:file,group:"native-external",round:1,case:descriptor.cases[0].id});assert.equal(evaluated.thresholds.cohort.slotCount,8);assert.equal(evaluated.thresholds.cohort.overallMatrixComplete,false);
 rejects(()=>matrix.evaluation({descriptor:descriptorFile,sourceVersion:"candidate",thresholds:file,group:"native-native",round:3,case:descriptor.cases[0].id}),"GROUP_LIVE_COHORT_CANDIDATE_SLOT_OUTSIDE_SCOPE");
});
test("incomplete, duplicated, unsupported and changed baseline cohorts fail before candidate",()=>{
 rejects(()=>cohort.freeze({descriptor,descriptorSha256,baselineReportPaths:first.slice(0,7),thresholds}),"GROUP_LIVE_COHORT_MANIFEST_INVALID");
 rejects(()=>cohort.freeze({descriptor,descriptorSha256,baselineReportPaths:[...first.slice(0,7),first[0]],thresholds}),"GROUP_LIVE_COHORT_SLOT_INVALID");
 rejects(()=>cohort.facts(descriptor,"native-native",1,descriptor.cases[0].id),"GROUP_LIVE_COHORT_SLOT_INVALID");
 const modified=JSON.parse(JSON.stringify(manifest));modified.baselineComplete=true;rejects(()=>cohort.validate(modified,{descriptor,descriptorSha256}),"GROUP_LIVE_COHORT_MANIFEST_INVALID");
 const original=fs.readFileSync(first[0]);fs.appendFileSync(first[0],"\n");rejects(()=>cohort.validate(manifest,{descriptor,descriptorSha256}),"GROUP_LIVE_COHORT_BASELINE_CHANGED");fs.writeFileSync(first[0],original);
 const noObservation=JSON.parse(original);noObservation.serviceStopped=null;fs.writeFileSync(first[0],JSON.stringify(noObservation));rejects(()=>cohort.freeze({descriptor,descriptorSha256,baselineReportPaths:first,thresholds}),"GROUP_LIVE_COHORT_BASELINE_NOT_OBSERVED");fs.writeFileSync(first[0],original);
});
test("matching guard and model sets remain conditional protocol comparisons, and unknowns remain confounders",()=>{
 const left=report(cohort.facts(descriptor,"native-external",1,descriptor.cases[0].id)),right=JSON.parse(JSON.stringify(left));right.evaluation.sourceVersion="candidate";
 assert(cohort.assessPair(left,right).confounders.includes("effective-model-pairing-unavailable"));
 for(const row of[left,right]){row.effectiveModelEvidence=[{completed:true,effectiveModel:"synthetic-unit-model"}];row.memberModelPairingEvidence=[{roleId:"lead",runtime:"codex",actualCompletedModelProof:true,effectiveModels:["synthetic-unit-model"],requestedParameters:[],runtimeReportedParameters:[]},{roleId:"reviewer",runtime:"hermes",actualCompletedModelProof:true,effectiveModels:["synthetic-unit-model"],configuredParameters:{temperature:0},runtimeReportedParameters:[{temperature:0}]}];}
 assert.equal(cohort.assessPair(left,right).comparisonEligibility,"requires-human-protocol-and-per-member-parameter-review");assert.equal(cohort.assessPair(left,right).pureSchedulingAttribution,false);
 right.guardEnvironmentFingerprint="c".repeat(64);assert(cohort.assessPair(left,right).confounders.includes("different-external-file-network-context-guard-environment"));right.guardEnvironmentFingerprint=null;assert(cohort.assessPair(left,right).confounders.includes("external-guard-environment-unavailable"));
});
test("per-member pairing never promotes a session cumulative model into a completed external model",()=>{
 const profiles=[{id:"owned-native",evaluationRoleId:"lead",runtimeProfileId:"owned-dsh"}],roles=[{id:"lead",runtime:"deepseek-harness"},{id:"contributor",runtime:"hermes"}];
 const result={runOutcomes:[{id:"native-run",profileId:"owned-native",status:"completed"}],effectiveModelEvidence:[{runId:"native-run",effectiveModel:"reported-dsh-model"}],runtimeOperationEvidence:[],external:{models:[{backendId:"hermes",model:"configured-hermes-model",provider:"existing-provider",parameters:null}]},externalObservations:[{backendId:"hermes",sessions:[{model:"cumulative-hermes-model",executions:[{runId:"hermes-run",status:"completed"}],history:{bindings:[{runId:"hermes-run",effectiveModel:null,uniqueInputResultPair:true}]},rawRuntimeSession:{modelConfig:{temperature:0}}}]}]};
 const members=worker.memberModelPairingEvidence(result,roles,profiles);assert.equal(members[0].actualCompletedModelProof,true);assert.equal(members[1].completedRuns,1);assert.equal(members[1].actualCompletedModelProof,false);assert.deepEqual(members[1].effectiveModels,[]);assert.deepEqual(members[1].sessionCumulativeModels,["cumulative-hermes-model"]);
 const pair={evaluation:{},guardEnvironmentFingerprint:"e".repeat(64),effectiveModelEvidence:result.effectiveModelEvidence.map(row=>({...row,completed:true})),memberModelPairingEvidence:members};assert(cohort.assessPair(pair,pair).confounders.includes("per-member-effective-model-unavailable:hermes/contributor"));
});
test("guard fingerprint normalizes owned paths and excludes only declared group inventory treatment",()=>{
 const make=tag=>{const own=path.join(root,tag),workspace=path.join(own,"workspace");fs.mkdirSync(workspace,{recursive:true,mode:0o700});return{isolation:{root:own,workspace},evaluation:{runtimes:["codex"]},runtimeBinaries:[{runtime:"codex",sha256:"d".repeat(64),version:"synthetic"}],toolEnvironment:{runtimes:[{runtime:"codex",actualRuntimeVerified:true,method:"synthetic-fixture",config:{filesystem:{[workspace]:"read"},"mcp_servers.shoggoth.enabled_tools":tag==="left"?cohort.BASELINE_TOOLS:cohort.CANDIDATE_TOOLS},disabledInheritedMcpNames:["disabled-other"],afterFeatureInventories:[{threadId:tag,features:[{name:"apps",enabled:false}]}]}]}};};
 const left=make("left"),right=make("right");assert.equal(worker.guardEnvironment(left,"facts").sha256,worker.guardEnvironment(right,"facts").sha256);
 right.toolEnvironment.runtimes[0].config.filesystem[right.isolation.workspace]="write";assert.notEqual(worker.guardEnvironment(left,"facts").sha256,worker.guardEnvironment(right,"facts").sha256);
 right.toolEnvironment.runtimes[0].actualRuntimeVerified=false;assert.equal(worker.guardEnvironment(right,"facts"),null);
});
test("OpenClaw fingerprint binds selected authority and kernel capabilities without volatile process identity",()=>{
 const make=tag=>{
  const own=path.join(root,"auth-"+tag),workspace=path.join(own,"workspace");fs.mkdirSync(workspace,{recursive:true,mode:0o700});
  const file=path.join(own,"tool-policy.json"),kernelFile=path.join(own,"reader-policy.sb"),toolPolicy={workspace,readRoots:[workspace],groupTools:tag==="left"?cohort.BASELINE_TOOLS:cohort.CANDIDATE_TOOLS};
  fs.writeFileSync(file,JSON.stringify(toolPolicy),{mode:0o600});fs.writeFileSync(kernelFile,"owned-kernel-source-"+tag,{mode:0o400});
  const sdkFiles=["dist/store-runtime-j0iCH_e-.mjs","dist/store-BVWJOVBa.mjs","dist/order-BsYOMdUo.mjs","dist/sqlite-json-B-NT4SVB.mjs","dist/gateway-state-owner-YpBfU4aL.mjs","dist/paths-CtO6iw0c.mjs","dist/openclaw-state-db.paths-rJI64Ab5.mjs","dist/pid-alive-BYw_9KTp.mjs","dist/stale-lock-file-WwPWbFq9.mjs"].map(relative=>{const file=path.join("/opt/homebrew/lib/node_modules/openclaw",relative);return{relative,sha256:sha(fs.readFileSync(file)),bytes:fs.statSync(file).size};});
  return {isolation:{root:own,workspace},evaluation:{runtimes:["openclaw"]},external:{toolPolicies:{openclaw:{policyFile:file,method:"synthetic-tool-body"}},contextPolicies:{openclaw:{memoryPluginSlot:"none"}},
   runtimeBinaryEvidence:[{runtime:"openclaw",sha256:"a".repeat(64),guardAttestation:{registryContainsAcceptedPolicy:true},sdkFiles}],
   models:[{backendId:"openclaw",authAuthority:{method:"installed-SDK-readOnly-runtime-store-and-readOnly-auth-order;only-selected-api-key-in-owned-provider-config",provider:"selected-provider",model:"selected-provider/model",profileIdDigest:"b".repeat(64),credentialType:"api_key",sdkFiles,
    kernelReader:{pid:tag==="left"?123:456,policyFile:kernelFile,policySha256:sha("owned-kernel-source-"+tag),sourceConfigSha256:"c".repeat(64),method:"deny-default-seatbelt-original-auth-sqlite-read-only-no-original-write-no-network-no-fork-no-keychain;anonymous-FD3-only-selected-key",credentialChannel:"private-anonymous-FD3;no-stdout-stderr-env-file",sourceOriginalWriteAllowed:false,networkAllowed:false,keychainAllowed:false,forkAllowed:false,ownedCodeByteEquality:true,helperSourceSha256:sha(fs.readFileSync(path.join(__dirname,"group-collaboration-openclaw-auth.cjs"))),readerSourceSha256:sha(fs.readFileSync(path.join(__dirname,"group-collaboration-openclaw-auth-reader.cjs"))),readCapabilitySummary:{authSqliteFiles:2,authWalShmExactLiterals:4,lifecycleOwnerSidecarExactLiterals:2,sourceDirectoryDataRead:false}}}}]}}; // gitleaks:allow -- Non-secret transport description
 };
 const left=make("left"),right=make("right"),get=result=>worker.guardEnvironment(result,"facts").sha256;
 assert.equal(get(left),get(right));
 const auth=right.external.models[0].authAuthority;
 auth.profileIdDigest="d".repeat(64);assert.notEqual(get(left),get(right));auth.profileIdDigest="b".repeat(64);
 auth.kernelReader.sourceConfigSha256="e".repeat(64);assert.notEqual(get(left),get(right));auth.kernelReader.sourceConfigSha256="c".repeat(64);
 auth.kernelReader.networkAllowed=true;assert.equal(worker.guardEnvironment(right,"facts"),null);auth.kernelReader.networkAllowed=false;
 auth.sdkFiles.pop();assert.equal(worker.guardEnvironment(right,"facts"),null);auth.sdkFiles.push(left.external.models[0].authAuthority.sdkFiles[8]);
 auth.sdkFiles[0]={...auth.sdkFiles[0],sha256:"f".repeat(64)};assert.equal(worker.guardEnvironment(right,"facts"),null);auth.sdkFiles[0]=left.external.models[0].authAuthority.sdkFiles[0];
 auth.kernelReader.readCapabilitySummary.lifecycleOwnerSidecarExactLiterals=3;assert.equal(worker.guardEnvironment(right,"facts"),null);auth.kernelReader.readCapabilitySummary.lifecycleOwnerSidecarExactLiterals=2;
 auth.kernelReader.readCapabilitySummary.sourceDirectoryDataRead=true;assert.equal(worker.guardEnvironment(right,"facts"),null);auth.kernelReader.readCapabilitySummary.sourceDirectoryDataRead=false;
 const helper=auth.kernelReader.helperSourceSha256;auth.kernelReader.helperSourceSha256="f".repeat(64);assert.equal(worker.guardEnvironment(right,"facts"),null);auth.kernelReader.helperSourceSha256=helper;
 const method=auth.method;auth.method="unsupported-auth-method";assert.equal(worker.guardEnvironment(right,"facts"),null);auth.method=method;
 fs.chmodSync(auth.kernelReader.policyFile,0o600);fs.appendFileSync(auth.kernelReader.policyFile,"changed");assert.equal(worker.guardEnvironment(right,"facts"),null);
});
test("DSH permits only the official metadata version argv and missing SDK evidence remains unknown",()=>{
 const host={launch:{command:"/fixed/node",argsPrefix:["/fixed/dsh/lib/bin.js"]}};
 assert.equal(worker.deepSeekVersionProbe(host,"/fixed/node",["/fixed/dsh/lib/bin.js","--version"]),true);
 for(const args of [["/fixed/dsh/lib/bin.js","--version","--profile","headless"],["/fixed/dsh/lib/bin.js","--help"],["/fixed/dsh/lib/bin.js","--version; echo wrong"]])assert.equal(worker.deepSeekVersionProbe(host,"/fixed/node",args),false);
 assert.equal(worker.deepSeekVersionProbe(host,"/other/node",["/fixed/dsh/lib/bin.js","--version"]),false);
 const unknown=worker.runtimeSdkObservation({toolEnvironment:{runtimes:[{runtime:"deepseek-harness",launches:[]}]}});assert.equal(unknown.unchanged,null);assert.equal(unknown.availability,"unavailable-no-admitted-sdk-launch");
 const file=path.join(root,"synthetic-sdk.txt");fs.writeFileSync(file,"before",{mode:0o600});const result={toolEnvironment:{runtimes:[{runtime:"deepseek-harness",launches:[{contextComposition:{sdkFiles:[{path:file,sha256:sha("before")}]}}]}]}};assert.equal(worker.runtimeSdkObservation(result).unchanged,true);fs.writeFileSync(file,"after");assert.equal(worker.runtimeSdkObservation(result).unchanged,false);fs.unlinkSync(file);assert.equal(worker.runtimeSdkObservation(result).unchanged,null);
});
test("actual matrix layout keeps every Runtime role and trusted OC policy inside the newly-owned root",()=>{
 const requested=path.join(root,"requested-layout"),layout=worker.matrixOwnedLayout(requested);
 try{
  assert.notEqual(layout.workspace,requested);assert.equal(fs.realpathSync(layout.workspace),path.join(layout.root,"workspace"));assert.deepEqual(fs.readdirSync(requested),[]);
  const roles=["lead","contributor","reviewer"].map(name=>{const directory=path.join(layout.workspace,name);fs.mkdirSync(directory,{mode:0o700});return directory;});
  const prepared=require("./group-collaboration-openclaw-policy.cjs").prepareGuard({root:layout.root,workspace:roles[2],readRoots:roles,caseId:"implementation-review",groupTools:cohort.BASELINE_TOOLS});
  assert.equal(prepared.policy.workspace,roles[2]);assert(prepared.policy.readRoots.every(directory=>directory.startsWith(layout.root+path.sep)));assert.equal(fs.existsSync(prepared.policyEvidence.policyFile),true);
  assert.equal(matrix.exactWriteApproval({kind:"runtime_approval",runId:"owned-run",requestId:"owned-request",expiresAt:null,approvalDetails:{kind:"command",cwd:roles[0],command:"printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'"},approvalOptions:[{kind:"allow_once",choice:"once"}],approvalChoices:["once","deny"]},roles[0]).target,path.join(roles[0],"approval-proof.txt"));
  rejects(()=>worker.matrixOwnedLayout(layout.workspace),"GROUP_LIVE_PRIVATE_DIRECTORY_REQUIRED");
 }finally{fs.rmSync(layout.root,{recursive:true,force:true});}
});
test("actual installed DSH public profile template guard rejects synthetic custom prompt layers and links",()=>{
 const binary=process.env.SHOGGOTH_TEST_DSH_BINARY||path.join(require("node:os").homedir(),".local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js");if(!fs.existsSync(binary))return;
 const home=path.join(root,"dsh-home"),profile=path.join(home,"profiles/headless");fs.mkdirSync(profile,{recursive:true,mode:0o700});
 const patch="# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n";
 fs.writeFileSync(path.join(profile,"cordis.patch.yml"),patch,{mode:0o600});fs.writeFileSync(path.join(profile,"package.json"),JSON.stringify({name:"dsh-profile-headless",private:true,dependencies:{},dsh:{profile:{bundles:["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}},null,2)+"\n",{mode:0o600});
 const input={binaryPath:binary,home,profile:"headless"};assert.equal(policy.verifyDeepSeekContextComposition(input).files.every(file=>file.matchesInstalledTemplate),true);
 fs.writeFileSync(path.join(home,"cordis.patch.yml"),"- insert: []\n",{mode:0o600});rejects(()=>policy.verifyDeepSeekContextComposition(input),"GROUP_LIVE_DEEPSEEK_HOME_PATCH_PRESENT");fs.unlinkSync(path.join(home,"cordis.patch.yml"));
 fs.appendFileSync(path.join(profile,"cordis.patch.yml"),"# custom prompt layer\n");rejects(()=>policy.verifyDeepSeekContextComposition(input),"GROUP_LIVE_DEEPSEEK_PROFILE_TEMPLATE_CHANGED");fs.writeFileSync(path.join(profile,"cordis.patch.yml"),patch);
 fs.renameSync(path.join(profile,"package.json"),path.join(home,"manifest.json"));fs.symlinkSync(path.join(home,"manifest.json"),path.join(profile,"package.json"));rejects(()=>policy.verifyDeepSeekContextComposition(input),"GROUP_LIVE_DEEPSEEK_PROFILE_UNSAFE");
});
test("cohort failure observations retain unknown code digests without exporting native values or zero usage",()=>{
 const slot=cohort.facts(descriptor,"native-external",1,descriptor.cases[0].id),raw=report(slot),secret=["PRIVATE","COHORT","ERROR","TOKEN","ABCDABCDABCDABCDABCDABCDABCDABCD"].join("_");raw.errorCode=secret;
 const observed=cohort.observation(raw,slot,descriptorSha256,descriptor.sourcePolicy.baselineGit);assert.equal(observed.status,"failed");assert.equal(observed.errorCode,"GROUP_LIVE_DIAGNOSTIC_CODE_UNKNOWN");assert.equal(observed.errorCodeDigest,sha("string:"+secret));assert.equal(observed.providerRequestCount,null);assert(!JSON.stringify(observed).includes(secret));
 const saved=matrix.safeEvidence(raw),reprojected=cohort.observation(saved,slot,descriptorSha256,descriptor.sourcePolicy.baselineGit);assert.equal(reprojected.errorCodeDigest,observed.errorCodeDigest);assert.equal(reprojected.errorCodeAvailability,"unknown-runtime-code");assert.equal(reprojected.status,"failed");assert.equal(reprojected.providerRequestCount,null);assert(!JSON.stringify(reprojected).includes(secret));
 const prior=fs.readFileSync(first[0]);try{fs.writeFileSync(first[0],JSON.stringify(saved),{mode:0o600});const frozen=cohort.freeze({descriptor,descriptorSha256,baselineReportPaths:first,thresholds});assert.equal(frozen.partialCohort.slots[0].observation.errorCodeDigest,observed.errorCodeDigest);assert.equal(frozen.partialCohort.slots[0].observation.status,"failed");assert(!JSON.stringify(frozen).includes(secret));}finally{fs.writeFileSync(first[0],prior);}
});
try{for(const{name,fn}of tests){fn();console.log("PASS "+name);}console.log(`All ${tests.length} cohort/guard checks passed; Provider 0.`);}finally{fs.rmSync(root,{recursive:true,force:true});}
