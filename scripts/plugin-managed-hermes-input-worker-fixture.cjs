"use strict";
// Fixed installed source is read only. No candidate/Host/model or dependency copy.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createManagedHermesHostClient,_protocol:p}=require('../app/managed-hermes-host-client');
const {resolveManagedHermesProductInputs,_test}=require('../app/managed-hermes-product-inputs');
const {hashFile,snapshotRuntimeTree}=require('../app/managed-plugin-host-runtime');
const {execFileSync}=require('node:child_process');const pins=require('../app/managed-hermes-runtime-pins.json');
const ROOT=path.resolve(__dirname,'..'),root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sgh-hermes-input-worker-proof-'));fs.chmodSync(root,0o700);
const source=resolveManagedHermesProductInputs({hermesBin:require('node:path').join(require('node:os').homedir(), '.local', 'bin', 'hermes'),architecture:'arm64'});
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'resources/external-plugin-host-patches/hermes/v1-c7c2df1/manifest.json'),'utf8'));
const sourceHashes=()=>Object.fromEntries(manifest.files.filter(row=>row.originalSha256!==null).map(row=>[row.path,hashFile(path.join(source.sourceRoot,row.path))]));
const before=sourceHashes();const files=['app/managed-hermes-product-inputs.js','app/managed-hermes-host-client.js','app/managed-hermes-host-worker.js','app/managed-hermes-host-supervisor.js','app/managed-hermes-runtime-pins.json','scripts/plugin-managed-hermes-input-worker-fixture.cjs'];
const hashes=()=>Object.fromEntries(files.map(file=>[file,hashFile(path.join(ROOT,file))]));const codeHashes=hashes();
let client,closePromise,modelStarts=0,progress=[],ticks=0;const timer=setInterval(()=>ticks++,1);
function options(name){const stateDir=path.join(root,name);fs.mkdirSync(stateDir,{mode:0o700});return{stateDir,serviceUserDataRoot:root,resourcesRoot:path.join(ROOT,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(ROOT,'resources/external-plugin-adapters'),...source,hermesConfiguration:{}};}
(async()=>{try{
 assert.equal(process.argv.length,2);assert.throws(()=>p.argsFor('normalizeInput',{sourceRoot:'/renderer'}),{code:'MANAGED_WORKER_COMMAND_INVALID'});
 assert.throws(()=>p.initFor({...options('invalid-mode'),inputMode:'renderer-ready'}),{code:'MANAGED_WORKER_INIT_INVALID'});
 const config=options('cancel-manager');client=createManagedHermesHostClient(config);await client.ready;
 client.onProgress(value=>{progress.push(value);if(value.operationState==='normalize_verify_original_closure'&&!closePromise){closePromise=client.close({operationId:'cancel-original-input',timeoutMs:5000});closePromise.catch(()=>{});}});
 await assert.rejects(client.controller.normalizeInput({}),{code:'MANAGED_WORKER_OPERATION_RETIRED'});assert(closePromise);await closePromise;
 assert.equal(client.getStatus().state,'closed');assert.equal(client.getEndpoint(),null);assert.equal(client.getExecution(),null);
 assert.equal(fs.existsSync(path.join(config.stateDir,'external-plugin-host-runtimes/hermes/candidates'))&&fs.readdirSync(path.join(config.stateDir,'external-plugin-host-runtimes/hermes/candidates')).length>0,false);
 const inputDir=config.stateDir+'.hermes-normalized-inputs';assert.deepEqual(fs.readdirSync(inputDir),[]);assert(ticks>2,'main event loop responsive during Worker normalization');
 assert.equal(JSON.stringify(progress).includes(source.sourceRoot),false);assert.equal(JSON.stringify(progress).includes(root),false);
 assert.deepEqual(sourceHashes(),before);client=null;
 // Actual full fixed-source closure checks precede disk guard; only execute this
 // non-copy proof when the machine cannot safely stage the frozen 571MB input.
 const volume=fs.statfsSync(root),available=Number(volume.bavail)*Number(volume.bsize);let diskGuard='not_required_on_current_volume';
 if(available<2*1024**3+2*571825949){
   const diskOptions=options('disk-manager');client=createManagedHermesHostClient(diskOptions);await client.ready;
   await assert.rejects(client.controller.normalizeInput({}),{code:'HERMES_DISK_PREFLIGHT_FAILED'});
   assert.deepEqual(fs.readdirSync(diskOptions.stateDir+'.hermes-normalized-inputs'),[]);assert.equal(client.getEndpoint(),null);assert.equal(client.getStatus().ownership,'absent');
   await client.close({operationId:'disk-proof-close',timeoutMs:5000});client=null;diskGuard='actual_fixed_closure_then_disk_preflight_zero_copy';assert.deepEqual(sourceHashes(),before);
 }
 // Reuse proof fixture setup is a forced APFS clone of the already verified
 // frozen normalized input, never a claim that this Worker normalized afresh.
 const reusedSource='/private/tmp/shoggoth-hermes-test-candidate/input';
 assert.equal(fs.realpathSync(reusedSource),reusedSource);assert.equal(snapshotRuntimeTree(reusedSource).sha256,pins.hosts.hermes.inputTreeSha256);
 const reuseOptions=options('reuse-manager'),reuseDir=reuseOptions.stateDir+'.hermes-normalized-inputs';fs.mkdirSync(reuseDir,{mode:0o700});
 const final=path.join(reuseDir,'input-'+pins.hosts.hermes.inputTreeSha256);assert(!fs.existsSync(final));
 assert(available>=128*1024*1024,'bounded APFS clone fixture metadata free space');
 execFileSync('/bin/cp',['-cR',reusedSource,final],{stdio:'ignore',timeout:60000});
 const seal=directory=>{for(const name of fs.readdirSync(directory)){const file=path.join(directory,name),stat=fs.lstatSync(file);if(stat.isDirectory()&&!stat.isSymbolicLink())seal(file);else if(stat.isFile())fs.chmodSync(file,stat.mode&0o111?0o500:0o400);}fs.chmodSync(directory,0o500);};seal(final);
 assert.equal(snapshotRuntimeTree(final,{immutable:true}).sha256,pins.hosts.hermes.inputTreeSha256);
 client=createManagedHermesHostClient(reuseOptions);await client.ready;const reused=await client.controller.normalizeInput({});
 assert.equal(reused.reused,true);assert.equal(reused.inputTreeSha256,pins.hosts.hermes.inputTreeSha256);assert.equal(reused.sourceRoot,final);
 assert.equal(client.getStatus().ownership,'absent');assert.equal(client.getEndpoint(),null);
 const filesBefore=fs.readdirSync(reuseDir);assert.deepEqual(filesBefore,[path.basename(final)]);
 const replay=await client.controller.normalizeInput({});assert.deepEqual(replay,reused);assert.deepEqual(fs.readdirSync(reuseDir),filesBefore);
 await client.close({operationId:'actual-input-reuse-close',timeoutMs:5000});client=null;_test.discardOwnedStage(reuseDir);
 const sealed=path.join(root,'new-owned-sealed-stage');fs.mkdirSync(sealed,{mode:0o700});fs.mkdirSync(path.join(sealed,'child'),{mode:0o700});fs.writeFileSync(path.join(sealed,'child/file'),'test',{mode:0o400});fs.chmodSync(path.join(sealed,'child'),0o500);fs.chmodSync(sealed,0o500);_test.discardOwnedStage(sealed);assert(!fs.existsSync(sealed));
 assert.deepEqual(hashes(),codeHashes);
 const result={version:1,status:'PASS',verifiedAt:new Date().toISOString(),sourceHashes:codeHashes,actualPrivateNodeWorker:true,originalFixedSourceReadOnly:true,normalizationCanceledBeforeCopyPublish:true,mainEventLoopResponsive:true,strictTrustedInputCommand:true,progressScrubbed:true,sealedUnpublishedStageCleanup:true,actualImmutableInputReuse:true,reuseFixtureAPFSCloneOnly:true,reuseRecheckedFixedTreeAndPythonClosure:true,diskGuard,newNormalizationCopies:0,hostStarts:modelStarts,modelRequests:0,globalWrites:0,remoteCalls:0,scope:'Actual Worker original-source verification cancellation and low-space fail-closed; immutable existing normalized input reuse; successful new 571MB normalization is a separate required positive proof'};
 if(process.env.SHOGGOTH_TEST_HERMES_INPUT_EVIDENCE_OUTPUT)fs.writeFileSync(process.env.SHOGGOTH_TEST_HERMES_INPUT_EVIDENCE_OUTPUT,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }catch(error){console.error(error.code||error.stack);process.exitCode=1;}finally{clearInterval(timer);if(client)await client.close({operationId:'fixture-input-cleanup',timeoutMs:15000}).catch(error=>console.error(error.code));_test.discardOwnedStage(root);}
})().catch(error=>{console.error(error.code||error.stack);process.exitCode=1;});
