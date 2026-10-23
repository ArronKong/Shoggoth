'use strict';
// One isolated production-manager candidate from the previously frozen input.
// No Host is launched and no installed environment or previous candidate is edited.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createManagedPluginHostRuntimeManager,snapshotRuntimeTree,hashFile}=require('../app/managed-plugin-host-runtime');
const pins=require('../app/managed-hermes-runtime-pins.json');
const repo=path.resolve(__dirname,'..'),sourceRoot='/private/tmp/shoggoth-hermes-test-candidate/input';
const FILES=['app/managed-hermes-runtime-pins.json','app/managed-plugin-host-runtime.js','scripts/hermes-managed-runtime-patch.cjs','scripts/plugin-hermes-managed-profile-candidate-prepare.cjs','resources/external-plugin-host-patches/hermes/managed-v3/manifest.json'];
async function main(){
 assert.equal(process.argv.length,2);assert.equal(fs.realpathSync(sourceRoot),sourceRoot);
 const codeHashes=Object.fromEntries(FILES.map(file=>[file,hashFile(path.join(repo,file))]));
 const input=snapshotRuntimeTree(sourceRoot);assert.equal(input.sha256,pins.hosts.hermes.inputTreeSha256);
 const disk=fs.statfsSync('/private/tmp'),available=Number(disk.bavail)*Number(disk.bsize),required=2*1024**3+2*input.bytes;
 assert(available>=required,'Keep the original 2 GiB + two logical-copy reserve; no candidate copy is started below it');
 const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sgh-hermes-managed-candidate-'));fs.chmodSync(root,0o700);
 const state=path.join(root,'worker-cache');fs.mkdirSync(state,{mode:0o700});
 try{
  const manager=createManagedPluginHostRuntimeManager({stateDir:state,resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),inputPins:pins});
  const candidate=await manager.prepareCandidate({backendId:'hermes',sourceRoot,interpreterPath:path.join(sourceRoot,'venv/bin/python'),architecture:'arm64'});
  assert.equal(candidate.runtimeTreeSha256,pins.hosts.hermes.outputTreeSha256);assert.equal(candidate.dependencyMode,'candidate-owned');
  assert.equal(snapshotRuntimeTree(candidate.runtimeRoot,{immutable:true}).sha256,candidate.runtimeTreeSha256);
  assert.deepEqual(Object.fromEntries(FILES.map(file=>[file,hashFile(path.join(repo,file))])),codeHashes);
  const marker={version:1,source:'production-manager-prepareCandidate',candidateId:candidate.candidateId,runtimeTreeSha256:candidate.runtimeTreeSha256,inputTreeSha256:input.sha256};
  fs.writeFileSync(path.join(state,'fixture-owned-candidate.json'),JSON.stringify(marker,null,2)+'\n',{mode:0o600,flag:'wx'});
  const report={version:1,passed:true,root,state,sourceRoot,candidateId:candidate.candidateId,runtimeRoot:candidate.runtimeRoot,runtimeTreeSha256:candidate.runtimeTreeSha256,inputTreeSha256:input.sha256,payloadManifestSha256:pins.hosts.hermes.payloadManifestSha256,inputLogicalBytes:input.bytes,availableBytesBefore:available,requiredBytesBefore:required,codeHashes,hostStarts:0,modelRequests:0,remoteRequests:0,globalWrites:0,scope:'Formal fixed production manager preparation and immutable full-tree proof; actual cold start/private profile/Service/React acceptance is a separate subsequent fixture.'};
  const reportPath='/private/tmp/sg-hermes-managed-profile-candidate.json';fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:true,state,candidateId:candidate.candidateId,runtimeTreeSha256:candidate.runtimeTreeSha256,report:reportPath}));return report;
 }catch(error){
  const mutable=dir=>{if(!fs.existsSync(dir))return;const stat=fs.lstatSync(dir);if(stat.isDirectory()&&!stat.isSymbolicLink()){fs.chmodSync(dir,0o700);for(const name of fs.readdirSync(dir))mutable(path.join(dir,name));}};
  mutable(root);fs.rmSync(root,{recursive:true,force:true});throw error;
 }
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});module.exports={main};
