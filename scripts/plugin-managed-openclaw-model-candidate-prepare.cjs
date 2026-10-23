"use strict";
// Explicit fixture preparation only. Does not activate or adopt any Host.
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {createManagedPluginHostRuntimeManager,snapshotRuntimeTree}=require('../app/managed-plugin-host-runtime');
const pins=require('../app/managed-openclaw-runtime-pins.json');
const repo=path.resolve(__dirname,'..');const sourceRoot='/opt/homebrew/lib/node_modules/openclaw';
async function main(){
 const source=snapshotRuntimeTree(sourceRoot);assert.equal(source.sha256,pins.hosts.openclaw.inputTreeSha256);
 const free=fs.statfsSync('/private/tmp');const available=Number(free.bavail)*Number(free.bsize);const reserve=2*1024*1024*1024;
 if(available<source.bytes+reserve)throw Object.assign(Error('keep at least 2 GiB available after the entire private runtime copy'),{code:'MODEL_FIXTURE_SPACE_RESERVE'});
 const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-managed-openclaw-model-'));fs.chmodSync(root,0o700);
 const manager=createManagedPluginHostRuntimeManager({stateDir:path.join(root,'app-state'),resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),inputPins:pins});
 process.stdout.write(JSON.stringify({phase:'preparing_model_read_candidate',root,sourceBytes:source.bytes,reserveBytes:reserve})+'\n');
 const candidate=await manager.prepareCandidate({backendId:'openclaw',sourceRoot,interpreterPath:(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')),architecture:'arm64'});
 assert.equal(candidate.runtimeTreeSha256,pins.hosts.openclaw.outputTreeSha256);assert.equal(manager.getCandidate('openclaw').candidateId,candidate.candidateId);
 assert.equal(snapshotRuntimeTree(sourceRoot).sha256,pins.hosts.openclaw.inputTreeSha256);
 const after=fs.statfsSync('/private/tmp');assert.ok(Number(after.bavail)*Number(after.bsize)>=reserve,'disk safety reserve changed; do not start Host');
 const evidence={version:1,status:'PASS',root,candidate,globalWrites:0,childrenStarted:0,originalTreeSha256:source.sha256,sourceBytes:source.bytes,reserveBytes:reserve,
  boundary:'fixed real original source/interpreter/dependencies and sealed candidate; no cold-start or managed deployment proof'};
 fs.writeFileSync(path.join(root,'model-candidate-preparation.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
 process.stdout.write(JSON.stringify({status:'PASS',root,candidateId:candidate.candidateId,runtimeTreeSha256:candidate.runtimeTreeSha256,childrenStarted:0})+'\n');
}
main().catch(error=>{process.stderr.write(JSON.stringify({status:'FAIL',code:error.code||null,message:error.message})+'\n');process.exitCode=1;});
