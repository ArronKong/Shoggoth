"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {createManagedPluginHostRuntimeManager,snapshotRuntimeTree,patchedTreeDigest,hashFile}=require('../app/managed-plugin-host-runtime');
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-managed-clone-unit-'));fs.chmodSync(root,0o700);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');const write=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});};
async function main(){try{
  const source=path.join(root,'source'),resources=path.join(root,'resources'),stateDir=path.join(root,'state');
  const entry="export const flavor='original';\n",patched=entry.replace("'original'","'patched'");
  write(path.join(source,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.5',engines:{node:'>=24.16.0 <25 || >=26.1.0'}}));
  write(path.join(source,'openclaw.mjs'),entry);const input=path.join(source,'node_modules/data.bin');write(input,Buffer.alloc(1024*1024,19));
  write(path.join(source,'LICENSE'),'Synthetic clone fixture only.\n');const payload=path.join(resources,'openclaw/fixture');write(path.join(payload,'LICENSE'),'Synthetic clone fixture only.\n');
  const manifest={version:1,package:'openclaw',packageVersion:'2026.9.5',files:[{path:'openclaw.mjs',beforeSha256:sha(entry),afterSha256:sha(patched),edits:[{before:"'original'",after:"'patched'"}]}],newFiles:[],dependencies:[]};
  write(path.join(payload,'manifest.json'),JSON.stringify(manifest));
  const node=(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node'));const probe=JSON.parse(execFileSync(node,['-p','JSON.stringify({version:process.versions.node,architecture:process.arch,platform:process.platform})'],{encoding:'utf8'}));
  const tree=snapshotRuntimeTree(source);const pin={version:1,backendId:'openclaw',hostVersion:'2026.9.5',inputTreeSha256:tree.sha256,
    outputTreeSha256:patchedTreeDigest(tree,[{path:'openclaw.mjs',bytes:Buffer.from(patched)}]),dependencyTreeSha256:snapshotRuntimeTree(path.join(source,'node_modules'),{containmentRoot:source}).sha256,
    payloadTreeSha256:snapshotRuntimeTree(payload).sha256,payloadManifestSha256:hashFile(path.join(payload,'manifest.json')),identityFile:'package.json',identityFileSha256:hashFile(path.join(source,'package.json')),
    dependencyPath:'node_modules',entryRelative:'openclaw.mjs',payloadRelative:'openclaw/fixture',manifestFile:'manifest.json',licenseFiles:[{path:'LICENSE',sha256:hashFile(path.join(source,'LICENSE'))}],interpreter:{...probe,sha256:hashFile(node)}};
  const force=path.join(root,'force-clone');let forceSupported=true;try{fs.copyFileSync(input,force,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE_FORCE);}catch(error){if(!['ENOTSUP','EOPNOTSUPP','ENOSYS'].includes(error.code))throw error;forceSupported=false;}
  const actualCopy=fs.copyFileSync;const flags=[];fs.copyFileSync=(src,dest,flag)=>{flags.push(flag);return actualCopy(src,dest,flag);};
  let manager,candidate;try{manager=createManagedPluginHostRuntimeManager({stateDir,resourcesRoot:resources,inputPins:{version:1,hosts:{openclaw:pin}}});
    candidate=await manager.prepareCandidate({backendId:'openclaw',sourceRoot:source,interpreterPath:node,architecture:probe.architecture});}finally{fs.copyFileSync=actualCopy;}
  assert.ok(flags.length>=4);assert.ok(flags.every(flag=>flag===(fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE)));
  const dest=path.join(candidate.runtimeRoot,'node_modules/data.bin'),s=fs.lstatSync(input),d=fs.lstatSync(dest);
  assert.notEqual(s.ino,d.ino);assert.equal(d.nlink,1);assert.equal(d.mode&0o222,0);assert.equal(snapshotRuntimeTree(candidate.runtimeRoot,{immutable:true}).sha256,pin.outputTreeSha256);
  fs.chmodSync(dest,0o600);fs.writeFileSync(dest,'modified owned candidate');assert.equal(hashFile(input),sha(Buffer.alloc(1024*1024,19)));
  assert.throws(()=>manager.getCandidate('openclaw'),e=>e.code==='RUNTIME_CANDIDATE_MUTABLE');
  fs.writeFileSync(dest,Buffer.alloc(1024*1024,19));fs.chmodSync(dest,0o400);assert.equal(manager.getCandidate('openclaw').candidateId,candidate.candidateId);
  assert.equal(snapshotRuntimeTree(source).sha256,pin.inputTreeSha256);
  await assert.rejects(manager.activateCandidate({backendId:'openclaw',candidateId:candidate.candidateId,operationId:'no-supervisor'}),e=>e.code==='RUNTIME_SUPERVISOR_UNAVAILABLE');
  process.stdout.write(JSON.stringify({status:'PASS',groups:4,forceCloneSupported:forceSupported,managerCopyFiles:flags.length,
    cases:['actual manager uses exclusive CoW-capable file copies with independent inode/nlink1','full fixed output hash and private read-only seal verified',
      'candidate write does not change original source; mutable candidate refused then exact restored input revalidated','copy optimization grants no activation authority or writer'],
    boundary:'1MiB synthetic package and actual Node; no production Host or disk-space waiver'})+'\n');
}finally{const loosen=dir=>{fs.chmodSync(dir,0o700);for(const item of fs.readdirSync(dir,{withFileTypes:true}))if(item.isDirectory())loosen(path.join(dir,item.name));};loosen(root);fs.rmSync(root,{recursive:true,force:true});}}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
