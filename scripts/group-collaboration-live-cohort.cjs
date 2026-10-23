"use strict";
// Partial comparisons preserve the original 72-slot descriptor. Each selected
// original group/round must contain all eight baseline observations before any
// candidate. Source protocol treatment is separate from external guard pairing.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const sha=value=>crypto.createHash("sha256").update(value).digest("hex");
const fail=code=>Object.assign(new Error(code),{code});
const GROUP_ROUNDS=Object.freeze(["native-native/3","native-external/1","native-hermes-openclaw/2","native-hermes-openclaw/3"]);
const BASELINE_TOOLS=Object.freeze(["group_member_role_read","group_messages_read","group_task"]);
const CANDIDATE_TOOLS=Object.freeze([...BASELINE_TOOLS,"group_collaborate"]);
const hex=value=>typeof value==="string"&&/^[a-f0-9]{64}$/u.test(value);
function read(file,max=32*1024*1024){
 if(!path.isAbsolute(file)||!file.startsWith("/private/tmp/")||path.resolve(file)!==file)throw fail("GROUP_LIVE_COHORT_FILE_UNSAFE");
 const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()||before.size>max)throw fail("GROUP_LIVE_COHORT_FILE_UNSAFE");
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const stat=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
  if(stat.dev!==before.dev||stat.ino!==before.ino||stat.size!==before.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs||bytes.length!==stat.size)throw fail("GROUP_LIVE_COHORT_FILE_CHANGED");
  return{file,data:JSON.parse(bytes),sha256:sha(bytes)};
 }finally{fs.closeSync(fd);}
}
function facts(descriptor,groupId,round,caseId){
 const group=descriptor.groups?.find(row=>row.id===groupId),sample=descriptor.cases?.find(row=>row.id===caseId),runtimes=group?.membersByRound?.[round-1];
 if(!sample||!Array.isArray(runtimes)||!GROUP_ROUNDS.includes(groupId+"/"+round))throw fail("GROUP_LIVE_COHORT_SLOT_INVALID");
 const roles=runtimes.map((runtime,position)=>{const role=descriptor.roles.find(row=>row.position===position);if(!role)throw fail("GROUP_LIVE_COHORT_SLOT_INVALID");return{id:role.id,position,card:role.card,runtime};});
 const data=caseId==="user-supplement"?{U1:sample.data.U1}:sample.data,body=descriptor.sharedPrompt+"\n\n"+sample.prompt+"\n\n合成资料：\n"+JSON.stringify(data,null,2);
 return{groupId,round,caseId,runtimes,roleDigest:sha(JSON.stringify(roles)),dataDigest:sha(JSON.stringify(data)),promptDigest:sha(body)};
}
function validateDescriptor(descriptor){
 if(descriptor.evaluationVersion!==1||descriptor.rounds!==3||descriptor.expectedMatrixRunsPerVersion!==72||descriptor.cases?.length!==8||new Set(descriptor.cases.map(row=>row.id)).size!==8)throw fail("GROUP_LIVE_COHORT_DESCRIPTOR_INVALID");
 for(const key of GROUP_ROUNDS){const slash=key.lastIndexOf("/"),group=key.slice(0,slash),round=Number(key.slice(slash+1));for(const sample of descriptor.cases)facts(descriptor,group,round,sample.id);}
}
function observation(report,slot,descriptorSha256,baselineGit){
 const e=report.evaluation;
 if(report.reportVersion!==2||e?.sourceVersion!=="baseline"||e.groupId!==slot.groupId||e.round!==slot.round||e.caseId!==slot.caseId||e.descriptorSha256!==descriptorSha256
  ||e.roleDigest!==slot.roleDigest||e.dataDigest!==slot.dataDigest||e.promptDigest!==slot.promptDigest||JSON.stringify(e.runtimes)!==JSON.stringify(slot.runtimes)
  ||report.source?.gitSha!==baselineGit||report.sourceUnchanged!==true||report.workerUnchanged!==true||report.runtimeBinaryUnchanged!==true||report.descriptorUnchanged!==true||report.serviceStopped!==true
  ||slot.runtimes.some(runtime=>["hermes","openclaw"].includes(runtime))&&report.externalStopped!==true||!Number.isFinite(report.durationMs)||report.durationMs<0
  ||!Array.isArray(report.stateTrajectories)||!report.stateTrajectories.length||!Array.isArray(report.runOutcomes)||!Array.isArray(report.finalMessages)
  ||!Array.isArray(report.tasks)||!report.groupOutcomes||!Array.isArray(report.requests))throw fail("GROUP_LIVE_COHORT_BASELINE_NOT_OBSERVED");
 // A business or Provider failure remains a baseline observation. Missing
 // evidence does not become success, effective model, or zero Provider usage.
 const fields=Object.getOwnPropertyDescriptors(report), projectedCode={code:fields.errorCode&&Object.hasOwn(fields.errorCode,"value")?fields.errorCode.value:fields.errorCode?{accessor:true}:null};
 for(const [from,to] of [["errorCodeDigest","codeDigest"],["errorCodeAvailability","codeAvailability"]])if(fields[from]&&Object.hasOwn(fields[from],"value"))projectedCode[to]=fields[from].value;
 return{status:report.status,...require("./group-collaboration-live-codes.cjs").diagnosticCode(projectedCode,null),sourceDigest:report.source.sourceDigest,workerSha256:report.worker?.sha256??null,
  guardEnvironmentSha256:hex(report.guardEnvironmentFingerprint)?report.guardEnvironmentFingerprint:null,
  groupProtocolInventory:report.toolEnvironment?.runtimes?.flatMap(row=>row.groupTools??[])??null,
  actualEffectiveModels:report.effectiveModelEvidence??null,perMemberModelParameters:report.memberModelPairingEvidence??null,providerRequestCount:report.usageAvailability?.providerRequestCount??null,
  comparisonEligibility:slot.runtimes.includes("deepseek-harness")&&report.runtimeSdkSourceUnchanged!==true?"confounded-sdk-source-observation-unavailable":hex(report.guardEnvironmentFingerprint)?"requires-paired-candidate-assessment":"confounded-guard-environment-unavailable"};
}
function validate(data,{descriptor,descriptorSha256,slot}){
 validateDescriptor(descriptor);const cohort=data.partialCohort;
 if(data.evaluationVersion!==1||data.descriptorSha256!==descriptorSha256||data.baselineGit!==descriptor.sourcePolicy.baselineGit||data.baselineComplete!==false||data.overallMatrixComplete!==false
  ||data.frozenBeforeCandidate!==true||!cohort||cohort.version!==1||cohort.expectedAvailableSlots!==32||cohort.expectedMatrixSlots!==72||cohort.baselineObservationsComplete!==true
  ||!Array.isArray(cohort.selectedGroupRounds)||!cohort.selectedGroupRounds.length||cohort.selectedGroupRounds.length>4||new Set(cohort.selectedGroupRounds).size!==cohort.selectedGroupRounds.length
  ||cohort.selectedGroupRounds.some(key=>!GROUP_ROUNDS.includes(key))||!Array.isArray(cohort.slots)||cohort.slots.length!==cohort.selectedGroupRounds.length*8
  ||cohort.slotCount!==cohort.slots.length||!data.thresholds||typeof data.thresholds!=="object")throw fail("GROUP_LIVE_COHORT_MANIFEST_INVALID");
 const protocol=cohort.predeclaredProtocolTreatment;
 if(protocol?.kind!=="product-group-protocol"||JSON.stringify(protocol.baselineGroupTools)!==JSON.stringify(BASELINE_TOOLS)||JSON.stringify(protocol.candidateGroupTools)!==JSON.stringify(CANDIDATE_TOOLS)
  ||protocol.externalGuardByteIdenticalClaim!==false)throw fail("GROUP_LIVE_COHORT_PROTOCOL_TREATMENT_INVALID");
 const seen=new Set();
 for(const entry of cohort.slots){const wanted=facts(descriptor,entry.groupId,entry.round,entry.caseId),key=entry.groupId+"/"+entry.round+"/"+entry.caseId;
  if(seen.has(key)||!cohort.selectedGroupRounds.includes(entry.groupId+"/"+entry.round)||!hex(entry.baselineReportSha256))throw fail("GROUP_LIVE_COHORT_SLOT_INVALID");seen.add(key);
  const actual=read(entry.baselineReportPath);if(actual.sha256!==entry.baselineReportSha256)throw fail("GROUP_LIVE_COHORT_BASELINE_CHANGED");
  const observed=observation(actual.data,wanted,descriptorSha256,data.baselineGit);
  if(JSON.stringify(observed)!==JSON.stringify(entry.observation))throw fail("GROUP_LIVE_COHORT_OBSERVATION_CHANGED");
 }
 for(const key of cohort.selectedGroupRounds)for(const sample of descriptor.cases)if(!seen.has(key+"/"+sample.id))throw fail("GROUP_LIVE_COHORT_SLOT_MISSING");
 if(slot&&!seen.has(slot.group+"/"+slot.round+"/"+slot.case))throw fail("GROUP_LIVE_COHORT_CANDIDATE_SLOT_OUTSIDE_SCOPE");
 return{kind:"partial-cohort-comparison",slotCount:cohort.slotCount,expectedAvailableSlots:32,expectedMatrixSlots:72,overallMatrixComplete:false,
  untouchedMatrixSlots:72-cohort.slotCount,selectedGroupRounds:[...cohort.selectedGroupRounds]};
}
function freeze({descriptor,descriptorSha256,baselineReportPaths,thresholds}){
 validateDescriptor(descriptor);if(!Array.isArray(baselineReportPaths)||!baselineReportPaths.length||!hex(descriptorSha256))throw fail("GROUP_LIVE_COHORT_FREEZE_INPUT_INVALID");
 const slots=baselineReportPaths.map(file=>{const actual=read(file),e=actual.data.evaluation,wanted=facts(descriptor,e?.groupId,e?.round,e?.caseId);
  return{groupId:wanted.groupId,round:wanted.round,caseId:wanted.caseId,baselineReportPath:file,baselineReportSha256:actual.sha256,
   observation:observation(actual.data,wanted,descriptorSha256,descriptor.sourcePolicy.baselineGit)};});
 const selectedGroupRounds=[...new Set(slots.map(row=>row.groupId+"/"+row.round))].sort();
 const data={evaluationVersion:1,descriptorSha256,baselineGit:descriptor.sourcePolicy.baselineGit,baselineComplete:false,overallMatrixComplete:false,frozenBeforeCandidate:true,
  thresholds,partialCohort:{version:1,frozenAt:new Date().toISOString(),expectedAvailableSlots:32,expectedMatrixSlots:72,slotCount:slots.length,selectedGroupRounds,
   baselineObservationsComplete:true,predeclaredProtocolTreatment:{kind:"product-group-protocol",baselineGroupTools:BASELINE_TOOLS,candidateGroupTools:CANDIDATE_TOOLS,
    externalGuardByteIdenticalClaim:false,comparison:"external-file-network-context-guard-pairing-is-separate-from-expected-source-protocol-treatment"},slots}};
 validate(data,{descriptor,descriptorSha256});return data;
}
function assessPair(baseline,candidate){
 const confounders=[],left=baseline.evaluation,right=candidate.evaluation;
 for(const key of ["descriptorSha256","groupId","round","caseId","dataDigest","roleDigest","promptDigest"])if(left?.[key]!==right?.[key])confounders.push("different-"+key);
 if(!hex(baseline.guardEnvironmentFingerprint)||!hex(candidate.guardEnvironmentFingerprint))confounders.push("external-guard-environment-unavailable");
 else if(baseline.guardEnvironmentFingerprint!==candidate.guardEnvironmentFingerprint)confounders.push("different-external-file-network-context-guard-environment");
 if(!Array.isArray(baseline.effectiveModelEvidence)||!Array.isArray(candidate.effectiveModelEvidence))confounders.push("effective-model-pairing-unavailable");
 else{
  const models=report=>[...new Set(report.effectiveModelEvidence.filter(row=>row.completed&&row.effectiveModel).map(row=>row.effectiveModel))].sort();
  const a=models(baseline),b=models(candidate);if(!a.length||!b.length)confounders.push("effective-model-pairing-unavailable");else if(JSON.stringify(a)!==JSON.stringify(b))confounders.push("different-runtime-effective-models");
 }
 for(const [label,report] of [["baseline",baseline],["candidate",candidate]])if(report.evaluation?.runtimes?.includes("deepseek-harness")&&report.runtimeSdkSourceUnchanged!==true)confounders.push(label+"-sdk-source-observation-unavailable");
 if(!Array.isArray(baseline.memberModelPairingEvidence)||!Array.isArray(candidate.memberModelPairingEvidence)) confounders.push("per-member-model-parameter-evidence-unavailable");
 else {
  const memberKey=row=>row.runtime+"/"+row.roleId, rightMembers=new Map(candidate.memberModelPairingEvidence.map(row=>[memberKey(row),row]));
  if(rightMembers.size!==candidate.memberModelPairingEvidence.length||baseline.memberModelPairingEvidence.length!==candidate.memberModelPairingEvidence.length)confounders.push("per-member-identity-mismatch");
  for(const row of baseline.memberModelPairingEvidence){const paired=rightMembers.get(memberKey(row));
   if(!paired||!row.actualCompletedModelProof||!paired.actualCompletedModelProof)confounders.push("per-member-effective-model-unavailable:"+memberKey(row));
   else if(JSON.stringify(row.effectiveModels)!==JSON.stringify(paired.effectiveModels))confounders.push("different-per-member-effective-model:"+memberKey(row));
   for(const key of["configuredParameters","requestedParameters","runtimeReportedParameters"])if(JSON.stringify(row[key]??null)!==JSON.stringify(paired?.[key]??null))confounders.push("different-per-member-"+key+":"+memberKey(row));
  }
 }
 return{comparisonEligibility:confounders.length?"confounded":"requires-human-protocol-and-per-member-parameter-review",confounders,
  pureSchedulingAttribution:false,expectedProtocolTreatment:{baselineGroupTools:BASELINE_TOOLS,candidateGroupTools:CANDIDATE_TOOLS},
  note:"The added product group tool is a declared source change. Matching sets alone do not prove per-member model/parameters or pure scheduling causality."};
}
module.exports={GROUP_ROUNDS,BASELINE_TOOLS,CANDIDATE_TOOLS,facts,read,freeze,validate,observation,assessPair};
