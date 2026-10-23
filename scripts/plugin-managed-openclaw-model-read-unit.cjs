"use strict";
// Exact shipped private handler with tiny dependency stubs: validates policy,
// not an actual Host/model deployment. Actual Gateway proof is separate.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const {pathToFileURL}=require('node:url');
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-model-read-unit-'));fs.chmodSync(root,0o700);
const resource=path.join(__dirname,'../resources/external-plugin-host-patches/openclaw/2026.9.5-managed-v2/shoggoth-managed-runtime.mjs');
const write=(name,text)=>fs.writeFileSync(path.join(root,name),text,{mode:0o600});
async function main(){try{
  write('shoggoth-managed-runtime.mjs',fs.readFileSync(resource));
  write('shoggoth-managed-admission.mjs',`export const state={version:1,protocol:'openclaw-managed-v1',backendId:'openclaw',pid:12345,nonce:'${'b'.repeat(64)}',runtimeRoot:'/private/tmp/unit',runtimeTreeSha256:'${'c'.repeat(64)}',dataRoot:'/private/tmp/unit-data',generation:'generation',paused:true,operationId:'model-op'};
export const managedRuntimeIdentity=()=>({...state});
export function authorizeManagedControl(p){if(Object.keys(p).length!==6||p.controlToken!=='${'a'.repeat(64)}'||p.nonce!==state.nonce||p.generation!==state.generation||p.deadlineAt<=Date.now()||p.deadlineAt>Date.now()+60000)throw Object.assign(Error('invalid'),{code:'MANAGED_RUNTIME_CONTROL_REJECTED'});}
export const pauseManagedRuntime=()=>{},resumeManagedRuntime=()=>{},retireManagedRuntime=()=>{};`);
  write('gateway-work-admission-8IGGoS0B.mjs','export const notifyManagedGatewayAdmissionChange=()=>{};');
  write('gateway-active-work-OAr0e9ce.mjs','export const t=ctx=>({idle:ctx.idle!==false,counts:{totalActive:ctx.idle===false?1:0}});');
  write('server-active-work-DMRG0p1i.mjs','export const t=ctx=>ctx;');
  write('runtime-D_mv_Ppq.mjs','export const l=()=>({});');
  write('shoggoth-capability-selection.mjs',"export const selectionCapabilities=()=>({adapters:[{adapterId:'shoggoth-shared-capabilities',adapterGeneration:'adapter-generation',instanceId:'adapter-instance'}]});");
  write('gateway-error-details-DkZaR0kI.mjs',"export const t={UNAVAILABLE:'UNAVAILABLE'};");write('error-codes-CvRR89D5.mjs','export const f=(code,message)=>({code,message});');
  const handler=`async function read({context,respond,params}){context.calls.push(params);if(context.readDelay)await new Promise(r=>setTimeout(r,context.readDelay));respond(true,{models:[{id:'probe/local'}],sessions:[],jobs:[]});}`;
  for(const [name,exportName,methods]of [['models-CXtMKHCu.mjs','modelsHandlers',['models.list']],['config-DCEMZjGn.mjs','configHandlers',['config.get']],
    ['sessions-read-C64Ih-v7.mjs','sessionReadHandlers',['sessions.list']],['cron-DDe3Rbo6.mjs','cronHandlers',['cron.list','cron.get']]])
    write(name,handler+`export const ${exportName}={`+methods.map(m=>JSON.stringify(m)+':read').join(',')+'};');
  const {managedRuntimeHandlers:h}=await import(pathToFileURL(path.join(root,'shoggoth-managed-runtime.mjs')).href);
  const context={calls:[],idle:true};const base={version:1,controlToken:'a'.repeat(64),nonce:'b'.repeat(64),operationId:'model-op',deadlineAt:Date.now()+50000,generation:'generation',requestDigest:'d'.repeat(64),readMethod:'models.list',readParams:{}};
  const call=async(params,ctx=context,signal)=>{let frames=[];await h['gateway.shoggoth.managed.model.read']({params,context:ctx,signal,client:{connect:{scopes:['operator.admin']}},req:{method:'gateway.shoggoth.managed.model.read'},respond:(ok,value,error)=>frames.push({ok,value,error})});return frames;};
  const first=await call(base);assert.equal(first.length,1);assert.equal(first[0].ok,true);assert.equal(first[0].value.requestDigest,base.requestDigest);
  assert.equal(first[0].value.proof.nonce,base.nonce);assert.equal(first[0].value.proof.generation,base.generation);assert.equal(first[0].value.proof.paused,true);
  const cases=['exact shipped handler binds first private read to actual authority, original operation/digest and paused nonce/generation proof'];
  for(const method of ['chat.send','config.patch','sessions.patch','cron.update','references.lease.acquire']){
    const count=context.calls.length;assert.equal((await call({...base,readMethod:method}))[0].ok,false);assert.equal(context.calls.length,count);
  }cases.push('chat/model/config/reference writes cannot be selected through the fixed read-handler whitelist');
  for(const update of [{controlToken:'f'.repeat(64)},{nonce:'e'.repeat(64)},{generation:'other-generation'},{operationId:'other-operation'},
    {deadlineAt:Date.now()+61000},{requestDigest:'e'.repeat(64)},{readParams:{view:'provider-config'}},{readParams:{controlToken:'a'.repeat(64)}},{authority:true}]){
    const count=context.calls.length;assert.equal((await call({...base,...update}))[0].ok,false);assert.equal(context.calls.length,count);
  }cases.push('wrong token/nonce/generation/owner/deadline/digest/extra parameters cannot invoke a handler or replace immutable digest binding');
  for(const [method,params]of [['config.get',{}],['sessions.list',{limit:50}],['cron.list',{includeDisabled:true,limit:50}],['cron.get',{id:'fixture-job'}]])
    assert.equal((await call({...base,readMethod:method,readParams:params}))[0].ok,true);
  cases.push('only bounded model/config/session/cron reads reach the corresponding upstream handler entry');
  const busy={calls:[],idle:false};assert.equal((await call(base,busy))[0].ok,false);assert.equal(busy.calls.length,0);
  const abort=new AbortController();const delayed={calls:[],readDelay:40};const reading=call(base,delayed,abort.signal);setTimeout(()=>abort.abort(),5);
  assert.equal((await reading)[0].ok,false);
  const deadline={calls:[],readDelay:50};const frames=await call({...base,deadlineAt:Date.now()+10},deadline);assert.equal(frames.length,1);assert.equal(frames[0].ok,false);
  await new Promise(resolve=>setTimeout(resolve,60));assert.equal(frames.length,1);
  cases.push('busy work, canceled read and expired handler deadline cannot return a success proof or a late second response');
  process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,boundary:'shipped private-handler schema/policy with dependency stubs; no actual Host/model claim'})+'\n');
}finally{fs.rmSync(root,{recursive:true,force:true});}}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
