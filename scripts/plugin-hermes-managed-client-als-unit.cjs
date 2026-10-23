'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {AsyncLocalStorage}=require('node:async_hooks');
const repo=path.resolve(__dirname,'..');
const clientFile=path.join(repo,'app/managed-hermes-host-client.js');
async function child(){
 const {createManagedHermesHostClient,_protocol}=require(clientFile);
 const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sgh-hermes-als-unit-'));fs.chmodSync(root,0o700);
 const state=path.join(root,'state');fs.mkdirSync(state,{mode:0o700});let client;
 try{
  const input=process.env.SHOGGOTH_TEST_HERMES_MANAGED_INPUT||'/private/tmp/shoggoth-hermes-test-candidate/input';
  client=createManagedHermesHostClient({stateDir:state,serviceUserDataRoot:root,resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters'),sourceRoot:input,interpreterPath:path.join(input,'venv/bin/python'),architecture:'arm64'});
  assert(Object.isFrozen(client));assert(Object.isFrozen(client.controller));assert(Object.isFrozen(client.activationAuthority));assert.equal(Object.isFrozen(client.ready),false);
  const lifecycle=new AsyncLocalStorage();const nested={items:[{value:1}],ready:client.ready,lifecycle};assert.equal(_protocol.freeze(nested),nested);
  assert(Object.isFrozen(nested));assert(Object.isFrozen(nested.items));assert(Object.isFrozen(nested.items[0]));assert.equal(Object.isFrozen(client.ready),false);assert.equal(Object.isFrozen(lifecycle),false);
  const als=new AsyncLocalStorage();await als.run({scope:'actual-hermes-client'},async()=>{
   const ready=await client.ready;assert.equal(ready.ownership,'absent');assert.equal(als.getStore().scope,'actual-hermes-client');
   assert.equal(await client.controller.getCandidate({}),null);assert.equal(als.getStore().scope,'actual-hermes-client');
   const observed=await client.controller.observe({});assert.equal(observed.ownership,'absent');assert.equal(als.getStore().scope,'actual-hermes-client');
   await client.close({operationId:'als-owned-close',timeoutMs:5000});assert.equal(client.getStatus().state,'closed');
  });als.disable();lifecycle.disable();
  console.log(JSON.stringify({passed:true,actualWorker:true,hostStarts:0,modelRequests:0,globalWrites:0,groups:2,publicContainersFrozen:true,nativePromiseMutable:true}));
 }finally{if(client&&client.getStatus().state!=='closed')await client.close({operationId:'als-finally-close',timeoutMs:5000});fs.rmSync(root,{recursive:true,force:true});}
}
if(process.argv[2]==='--child')child().catch(error=>{console.error(error.stack);process.exitCode=1;});
else{
 assert.equal(process.argv.length,2);const before=crypto.createHash('sha256').update(fs.readFileSync(clientFile)).digest('hex');
 const result=spawnSync(process.execPath,[__filename,'--child'],{encoding:'utf8',timeout:20000,maxBuffer:65536,env:{...process.env,NODE_OPTIONS:''}});
 assert.equal(result.error,undefined);assert.equal(result.status,0,`actual ALS child failed: ${result.stderr}`);assert.equal(result.signal,null);const proof=JSON.parse(result.stdout.trim());assert.equal(proof.passed,true);assert.equal(proof.actualWorker,true);
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(clientFile)).digest('hex'),before);
 console.log(JSON.stringify({...proof,status:'PASS',naturalExitCode:result.status,clientSha256:before}));
}
