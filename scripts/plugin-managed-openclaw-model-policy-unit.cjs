"use strict";
const assert=require('node:assert/strict');
const policy=require('../app/managed-openclaw-model-policy');
const {_protocol:p}=require('../app/managed-openclaw-host-client');
const {normalizeModelChangeRequest,modelChangeRequestDigest}=require('../app/core/model-change-validation');
const copy=x=>JSON.parse(JSON.stringify(x));const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);
const spec=normalizeModelChangeRequest({providerKey:'probe',sourceModelId:'old',model:{id:'new',name:'New',contextWindow:64000}}).safeSpec;
const row={id:'old',name:'Old',input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000};
const initial={gateway:{auth:{token:'protected'},reload:{mode:'off'}},plugins:{entries:{trusted:{enabled:true}}},tools:{profile:'minimal'},
  models:{mode:'replace',providers:{probe:{apiKey:'private-fixture-only',api:'openai-completions',baseUrl:'http://127.0.0.1/v1',models:[row]},foreign:{models:[{id:'foreign'}]}}},
  agents:{defaults:{workspace:'/fixed/private',heartbeat:{every:'0m'},model:{primary:'probe/old'},models:{'probe/old':{alias:'Original'}}},entries:[{id:'other',name:'Keep',model:{primary:'probe/old'}}]}};
const cases=[];
const unified={kind:'update-provider',providerKey:'probe',credentialScope:'provider',patch:{}};
assert.equal(policy.spec(unified).credentialScope,'provider');
rejects(()=>policy.spec({...unified,agentId:'other'}),'MANAGED_MODEL_SPEC_INVALID');
rejects(()=>policy.spec({...unified,credentialScope:'all'}),'MANAGED_MODEL_SPEC_INVALID');
assert.equal(policy.modelParams('models.authSetApiKey',{provider:'probe',agentId:'main',credentialScope:'provider'}),true);
rejects(()=>policy.modelParams('models.authSetApiKey',{provider:'probe',agentId:'main',credentialScope:'provider',agentIds:['other']}),'MANAGED_MODEL_RPC_INVALID');
cases.push('unified credential scope is explicit and rejects a selected Agent or a caller-supplied roster');
const undefinedSpec={...spec,baseUrl:undefined,api:undefined};const wire=policy.wireSpec(undefinedSpec);const restored=policy.restoreSpec(wire.safeSpec,wire.undefinedKeys,false);
assert.deepEqual(wire.undefinedKeys,['api','baseUrl']);assert.equal(modelChangeRequestDigest(restored),modelChangeRequestDigest(undefinedSpec));
rejects(()=>policy.digestMatches(restored,'a'.repeat(64),false),'MANAGED_MODEL_DIGEST_MISMATCH');
rejects(()=>policy.restoreSpec({...wire.safeSpec,api:'custom'},['api'],false),'MANAGED_MODEL_SPEC_INVALID');
const bad={...spec};Object.setPrototypeOf(bad,{apiKey:'hidden'});rejects(()=>policy.spec(bad),'MANAGED_MODEL_DATA_INVALID');
const getter={...spec};Object.defineProperty(getter,'api',{enumerable:true,get(){throw Error('getter invoked');}});rejects(()=>policy.spec(getter),'MANAGED_MODEL_DATA_INVALID');
cases.push('safeSpec own undefined fields survive private wire digest; forged digest, prototypes and accessors cannot grant a lease');
const target={...row,...spec.model};const valid=copy(initial);valid.models.providers.probe.models.push(target);
valid.agents.defaults.model.primary='probe/new';valid.agents.entries[0].model.primary='probe/new';
valid.agents.defaults.models={'probe/new':{alias:'Original'}};
assert.equal(policy.validatePatch(initial,valid,spec,initial),'change');
assert.equal(policy.validatePatch(valid,initial,spec,initial),'compensation');
cases.push('rename stage permits only exact bound source/target, preserved model defaults and model references; exact initial domain compensation is accepted');
for(const [mutate,code]of [
  [x=>x.gateway.auth.token='forged','MANAGED_MODEL_OWNED_CONFIG_CHANGED'],
  [x=>x.plugins.entries.trusted.enabled=false,'MANAGED_MODEL_OWNED_CONFIG_CHANGED'],
  [x=>x.tools.profile='full','MANAGED_MODEL_OWNED_CONFIG_CHANGED'],
  [x=>x.agents.defaults.workspace='/other','MANAGED_MODEL_AGENT_AUTHORITY_CHANGED'],
  [x=>x.agents.entries[0].name='Changed','MANAGED_MODEL_AGENT_AUTHORITY_CHANGED'],
  [x=>x.models.providers.foreign.models=[],'MANAGED_MODEL_OTHER_PROVIDER_CHANGED'],
  [x=>x.models.providers.probe.apiKey='stolen','MANAGED_MODEL_PROVIDER_AUTHORITY_CHANGED'],
  [x=>x.models.providers.probe.models[1].input=['image'],'MANAGED_MODEL_MODEL_UNBOUND'],
  [x=>x.agents.defaults.model.primary='foreign/new','MANAGED_MODEL_REFERENCE_UNRELATED'],
]){const x=copy(valid);mutate(x);rejects(()=>policy.validatePatch(initial,x,spec,initial),code);}
cases.push('Gateway credential/reload/plugin/tools/Agent non-model/provider secret/other provider/model runtime fields/unrelated reference changes fail closed');
const make=normalizeModelChangeRequest({providerKey:'newprovider',providerMode:'new',baseUrl:'http://127.0.0.1/v1',model:{id:'local'}}).safeSpec;
const newConfig=copy(initial);newConfig.models.providers.newprovider={api:'openai-completions',baseUrl:make.baseUrl,apiKey:'fixture-secret',models:[{id:'local',name:'local',input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]};
assert.equal(policy.validatePatch(initial,newConfig,make,initial),'change');newConfig.models.providers.newprovider.baseUrl='http://other/v1';
rejects(()=>policy.validatePatch(initial,newConfig,make,initial),'MANAGED_MODEL_PROVIDER_CREATE_UNBOUND');
cases.push('new provider allows only bound endpoint/API/model and transient model credential; different endpoint is rejected');
for(const method of ['chat.send','config.apply','gateway.shoggoth.managed.resume','sessions.patch','cron.update','references.lease.acquire'])
  rejects(()=>policy.modelParams(method,{}),'MANAGED_MODEL_RPC_UNSUPPORTED');
rejects(()=>policy.modelParams('config.patch',{raw:'{}',baseHash:'a'.repeat(64),replacePaths:[],authority:true}),'MANAGED_MODEL_RPC_INVALID');
rejects(()=>policy.modelParams('config.patch',{raw:'{}',baseHash:'a'.repeat(64),replacePaths:['z','a']}),'MANAGED_MODEL_RPC_INVALID');
rejects(()=>p.argsFor('modelAcquire',{operationId:'op',requestDigest:'a'.repeat(64),recovery:false,...wire}),'MANAGED_MODEL_DIGEST_MISMATCH');
const binding={token:'a'.repeat(64),operationId:'op',requestDigest:'b'.repeat(64),generation:'generation',writerNonce:'c'.repeat(64)};
rejects(()=>p.argsFor('modelAction',{binding,action:'rpc',params:{method:'chat.send',params:{}}}),'MANAGED_MODEL_RPC_UNSUPPORTED');
rejects(()=>p.argsFor('modelAction',{binding:{...binding,authority:true},action:'assert',params:{}}),'MANAGED_MODEL_IDENTITY_INVALID');
cases.push('private Worker fixed model command schema rejects model sends, arbitrary config/control and unverified reference writes before dispatch');
assert.equal(policy.targetMatches(valid,{models:[{provider:'probe',id:'new',name:'New',contextWindow:64000}]},spec),true);
assert.equal(policy.targetMatches(valid,{models:[]},spec),false);
assert.equal(policy.targetMatches(valid,{models:[{provider:'probe',id:'new',name:'New',contextWindow:64000},{provider:'probe',id:'old'}]},spec,{retired:true}),false);
assert.equal(policy.targetMatches(valid,{models:[{provider:'probe',id:'new',name:'Old publication',contextWindow:32000}]},spec),false);
cases.push('target proof requires actual prepared catalogue membership and projected name/context fields, rejecting stale publication and unretired rename source');
const subagents=copy(initial);subagents.agents.entries[0].subagents={model:'probe/old',maxConcurrent:2};
const migrated=copy(subagents);migrated.models.providers.probe.models.push(target);migrated.agents.entries[0].subagents.model='probe/new';
assert.equal(policy.validatePatch(subagents,migrated,spec,subagents),'change');migrated.agents.entries[0].subagents.model='unrelated/model';
rejects(()=>policy.validatePatch(subagents,migrated,spec,subagents),'MANAGED_MODEL_REFERENCE_UNRELATED');
const createSpec=normalizeModelChangeRequest({providerKey:'probe',model:{id:'new'}}).safeSpec;
rejects(()=>policy.validatePatch(initial,valid,createSpec,initial),'MANAGED_MODEL_REFERENCE_UNBOUND');
const unauthorized=copy(valid);unauthorized.agents.defaults.models['probe/new'].alias='Changed';
rejects(()=>policy.validatePatch(initial,unauthorized,spec,initial),'MANAGED_MODEL_REFERENCE_UNRELATED');
const aliasSource=copy(initial);aliasSource.agents.defaults.models['foreign/foreign']={alias:'Foreign alias',params:{temperature:0.9}};
const aliasCopy=copy(valid);aliasCopy.agents.defaults.models['foreign/foreign']=copy(aliasSource.agents.defaults.models['foreign/foreign']);
aliasCopy.agents.defaults.models['probe/new']=copy(aliasSource.agents.defaults.models['foreign/foreign']);
rejects(()=>policy.validatePatch(aliasSource,aliasCopy,spec,aliasSource),'MANAGED_MODEL_REFERENCE_UNRELATED');
cases.push('every canonical Agent subagents model is checked; unrelated subagent, alias/settings copied from foreign models and create/update reference migration are rejected');
const providerSpec={kind:'update-provider',providerKey:'probe',sourceModelId:null,sourceKey:null,targetKey:null,patch:{baseUrl:'http://127.0.0.1/new'}};
const providerChange=copy(initial);providerChange.models.providers.probe.baseUrl=providerSpec.patch.baseUrl;
assert.equal(policy.validatePatch(initial,providerChange,providerSpec,initial),'change');
providerChange.models.providers.probe.apiKey='unbound-replacement';
rejects(()=>policy.validatePatch(initial,providerChange,providerSpec,initial),'MANAGED_MODEL_PROVIDER_SECRET_AUTHORITY_UNAVAILABLE');
const clearSpec={...providerSpec,patch:{clearApiKey:true}};const cleared=copy(initial);delete cleared.models.providers.probe.apiKey;
assert.equal(policy.validatePatch(initial,cleared,clearSpec,initial),'change');
assert.equal(policy.targetMatches(cleared,{models:[]},clearSpec),true);assert.equal(policy.targetMatches(initial,{models:[]},clearSpec),false);
cases.push('ordinary provider endpoint edit cannot replace its secret without separate trusted authority; bound clearApiKey only deletes and target proof confirms removal');
process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases})+'\n');
