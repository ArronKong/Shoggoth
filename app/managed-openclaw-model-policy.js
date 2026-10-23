"use strict";
// App-private model transaction policy. No paths, tokens or Gateway authority
// can enter through a safeSpec or a model-only config patch.
const {isDeepStrictEqual:equal}=require('node:util');
const {modelChangeRequestDigest}=require('./core/model-change-validation');
const HASH=/^[a-f0-9]{64}$/;const OP=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KINDS=new Set(['create','update','rename','delete-model','delete-provider','update-provider','save-provider','batch']);
const FIELDS=new Set(['kind','providerMode','providerKey','sourceModelId','sourceKey','targetKey','target','baseUrl','api','model','patch','agentId','credentialScope','baseHash']);
const MODEL_FIELDS=new Set(['id','name','contextWindow','maxTokens','reasoning','advanced']);
const PATCH_FIELDS=new Set(['baseUrl','api','clearBaseUrl','clearApiKey','renameTo','modelIds','items','advanced']);
const fail=code=>Object.assign(new Error(code),{code});
function plain(v){return v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).every(k=>{
  const d=Object.getOwnPropertyDescriptor(v,k);return typeof k==='string'&&!['__proto__','constructor','prototype'].includes(k)&&d.enumerable&&Object.hasOwn(d,'value');});}
function capture(v,depth=0,budget={nodes:15000,bytes:2*1024*1024}){
  if(depth>24||--budget.nodes<0)throw fail('MANAGED_MODEL_DATA_INVALID');
  if(v===undefined||v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){budget.bytes-=Buffer.byteLength(v);if(budget.bytes<0)throw fail('MANAGED_MODEL_DATA_INVALID');return v;}
  if(typeof v==='number'&&Number.isFinite(v))return v;
  if(Array.isArray(v))return Object.freeze(v.map(x=>capture(x,depth+1,budget)));
  if(!plain(v))throw fail('MANAGED_MODEL_DATA_INVALID');const out={};
  for(const [k,x]of Object.entries(v))out[k]=capture(x,depth+1,budget);return Object.freeze(out);
}
function fields(v,allowed){if(!plain(v)||Object.keys(v).some(k=>!allowed.has(k)))throw fail('MANAGED_MODEL_SPEC_INVALID');}
function spec(value,recovery=false){const s=capture(value);fields(s,FIELDS);
  if(!KINDS.has(s.kind)||!PROVIDER.test(s.providerKey)||typeof recovery!=='boolean')throw fail('MANAGED_MODEL_SPEC_INVALID');
  if(s.sourceModelId!==undefined&&s.sourceModelId!==null&&(typeof s.sourceModelId!=='string'||!s.sourceModelId||s.sourceModelId.length>512))throw fail('MANAGED_MODEL_SPEC_INVALID');
  if(s.model!==undefined){fields(s.model,MODEL_FIELDS);if(typeof s.model.id!=='string'||!s.model.id||s.model.id.length>512)throw fail('MANAGED_MODEL_SPEC_INVALID');
    if(s.model.advanced!==undefined)require('./core/model-change-validation').normalizeModelAdvanced(s.model.advanced);
    for(const k of ['contextWindow','maxTokens'])if(Object.hasOwn(s.model,k)&&(!Number.isSafeInteger(s.model[k])||s.model[k]<=0))throw fail('MANAGED_MODEL_SPEC_INVALID');
    if(Object.hasOwn(s.model,'reasoning')&&typeof s.model.reasoning!=='boolean'||Object.hasOwn(s.model,'name')&&(typeof s.model.name!=='string'||!s.model.name))throw fail('MANAGED_MODEL_SPEC_INVALID');}
  if(s.patch!==undefined){fields(s.patch,PATCH_FIELDS);
    if(s.patch.advanced!==undefined)require('./core/model-change-validation').normalizeModelAdvanced(s.patch.advanced,{scope:'provider'});
    if(s.patch.renameTo&&!PROVIDER.test(s.patch.renameTo))throw fail('MANAGED_MODEL_SPEC_INVALID');
    if(s.patch.modelIds!==undefined&&(!Array.isArray(s.patch.modelIds)||s.patch.modelIds.length>1000
      ||new Set(s.patch.modelIds).size!==s.patch.modelIds.length||s.patch.modelIds.some(id=>typeof id!=='string'||!id||id.length>512||/[\0\r\n]/u.test(id))))throw fail('MANAGED_MODEL_SPEC_INVALID');
    if(s.patch.items!==undefined){if(s.kind!=='batch'||!Array.isArray(s.patch.items)||!s.patch.items.length||s.patch.items.length>100)throw fail('MANAGED_MODEL_SPEC_INVALID');
      for(const item of s.patch.items){if(['batch','save-provider'].includes(item.kind))throw fail('MANAGED_MODEL_SPEC_INVALID');spec(item,recovery);}}
  }
  if(s.agentId!==undefined&&(typeof s.agentId!=='string'||!s.agentId||s.agentId.length>128||/[\0\r\n]/u.test(s.agentId)))throw fail('MANAGED_MODEL_SPEC_INVALID');
  if(s.credentialScope!==undefined&&(s.credentialScope!=='provider'||s.agentId!==undefined))throw fail('MANAGED_MODEL_SPEC_INVALID');
  if(s.baseHash!==undefined&&(typeof s.baseHash!=='string'||!s.baseHash||s.baseHash.length>256||/[\0\r\n]/u.test(s.baseHash)))throw fail('MANAGED_MODEL_SPEC_INVALID');
  for(const k of ['baseUrl','api'])if(s[k]!==undefined&&typeof s[k]!=='string')throw fail('MANAGED_MODEL_SPEC_INVALID');
  for(const url of [s.baseUrl,s.patch?.baseUrl].filter(Boolean)){let u;try{u=new URL(url);}catch{throw fail('MANAGED_MODEL_SPEC_INVALID');}
    if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password)throw fail('MANAGED_MODEL_SPEC_INVALID');}
  if(!recovery){if(['create','update','rename'].includes(s.kind)&&(!s.model||s.targetKey!==JSON.stringify([s.providerKey,s.model.id])||!['new','existing'].includes(s.providerMode)))throw fail('MANAGED_MODEL_SPEC_INVALID');
    if(['update','rename','delete-model'].includes(s.kind)&&!s.sourceModelId)throw fail('MANAGED_MODEL_SPEC_INVALID');
    if(s.kind==='update-provider'&&!s.patch)throw fail('MANAGED_MODEL_SPEC_INVALID');}
  return s;
}
function wireSpec(value,recovery=false){const s=spec(value,recovery);const undefinedKeys=[];
  for(const [k,v]of Object.entries(s))if(v===undefined){if(!['baseUrl','api'].includes(k))throw fail('MANAGED_MODEL_SPEC_INVALID');undefinedKeys.push(k);}
  return {safeSpec:JSON.parse(JSON.stringify(s)),undefinedKeys:undefinedKeys.sort()};}
function restoreSpec(value,undefinedKeys,recovery){if(!Array.isArray(undefinedKeys)||!equal(undefinedKeys,[...new Set(undefinedKeys)].sort())||undefinedKeys.some(k=>!['baseUrl','api'].includes(k)||Object.hasOwn(value,k)))throw fail('MANAGED_MODEL_SPEC_INVALID');
  return spec({...value,...Object.fromEntries(undefinedKeys.map(k=>[k,undefined]))},recovery);}
function identity(v){if(!plain(v)||Object.keys(v).length!==2||!OP.test(v.operationId)||!HASH.test(v.requestDigest))throw fail('MANAGED_MODEL_IDENTITY_INVALID');return capture(v);}
function digestMatches(s,d,recovery){if(!HASH.test(d)||!recovery&&modelChangeRequestDigest(s)!==d)throw fail('MANAGED_MODEL_DIGEST_MISMATCH');}
const omit=(o,keys)=>Object.fromEntries(Object.entries(o||{}).filter(([k])=>!keys.includes(k)));
const domain=config=>({models:config.models??null,agents:config.agents??null});
function modelReferences(config){const a=JSON.parse(JSON.stringify(config.agents||{}));
  const strip=e=>{if(!e||!plain(e))return;
    if(plain(e.model)){delete e.model.primary;delete e.model.fallbacks;if(!Object.keys(e.model).length)delete e.model;}else if(typeof e.model==='string')delete e.model;
    if(plain(e.modelPolicy)){delete e.modelPolicy.allow;if(!Object.keys(e.modelPolicy).length)delete e.modelPolicy;}
    delete e.models;if(plain(e.subagents)){delete e.subagents.model;if(!Object.keys(e.subagents).length)delete e.subagents;}};
  strip(a.defaults);for(const collection of [a.entries,a.list])if(Array.isArray(collection))for(const entry of collection)strip(entry);
  else if(plain(collection))for(const entry of Object.values(collection))strip(entry);return a;
}
function referencesOnly(before,after,s){if(!['rename','delete-model','delete-provider'].includes(s.kind)&&!equal(before.agents,after.agents))throw fail('MANAGED_MODEL_REFERENCE_UNBOUND');
  if(!equal(modelReferences(before),modelReferences(after)))throw fail('MANAGED_MODEL_AGENT_AUTHORITY_CHANGED');
  const source=s.providerKey+'/'+s.sourceModelId,target=s.model?s.providerKey+'/'+s.model.id:null;
  const permitted=new Set([source,target]);
  if(s.kind==='delete-provider')for(const m of before.models?.providers?.[s.providerKey]?.models||[])permitted.add(s.providerKey+'/'+m.id);
  function compare(x,y,path=[]){if(equal(x,y))return;
    if(typeof x==='string'||typeof y==='string'){if((x===undefined||x===null||permitted.has(x))&&(y===undefined||y===null||permitted.has(y)))return;throw fail('MANAGED_MODEL_REFERENCE_UNRELATED');}
    if(Array.isArray(x)||Array.isArray(y)){if(!Array.isArray(x)||!Array.isArray(y))throw fail('MANAGED_MODEL_REFERENCE_UNRELATED');
      if(!equal(x.filter(v=>!permitted.has(v)),y.filter(v=>!permitted.has(v))))throw fail('MANAGED_MODEL_REFERENCE_UNRELATED');return;}
    if(plain(x)||plain(y)){const bx=x||{},by=y||{};for(const k of new Set([...Object.keys(bx),...Object.keys(by)])){
      // An alias/settings object may move only between the exact model keys.
      if(path.at(-1)==='models'&&!permitted.has(k)){if(!equal(bx[k],by[k]))throw fail('MANAGED_MODEL_REFERENCE_UNRELATED');continue;}
      if(path.at(-1)==='models'&&permitted.has(k)){
        if(by[k]!==undefined&&!Object.entries(bx).some(([priorKey,prior])=>permitted.has(priorKey)&&equal(prior,by[k])))throw fail('MANAGED_MODEL_REFERENCE_UNRELATED');continue;}
      compare(bx[k],by[k],[...path,k]);}return;}
    throw fail('MANAGED_MODEL_REFERENCE_UNRELATED');
  }
  const b=before.agents||{},a=after.agents||{};const entries=c=>Array.isArray(c)?Object.fromEntries(c.map(e=>[e.id,e])):c||{};
  const pairs=[[b.defaults||{},a.defaults||{}],...Object.keys(entries(b.entries||b.list)).map(k=>[entries(b.entries||b.list)[k],entries(a.entries||a.list)[k]])];
  for(const[x,y]of pairs){for(const k of ['model','modelPolicy','models'])compare(x?.[k],y?.[k],[k]);
    compare(x?.subagents?.model,y?.subagents?.model,['subagents','model']);}
}
function validatePatch(before,after,s,initial){
  if(!plain(before)||!plain(after)||!equal(omit(before,['models','agents']),omit(after,['models','agents'])))throw fail('MANAGED_MODEL_OWNED_CONFIG_CHANGED');
  const bk=s.providerKey,b=before.models?.providers?.[bk],a=after.models?.providers?.[bk];
  if(!equal(omit(before.models,['providers']),omit(after.models,['providers']))||!equal(omit(before.models?.providers,[bk]),omit(after.models?.providers,[bk])))throw fail('MANAGED_MODEL_OTHER_PROVIDER_CHANGED');
  referencesOnly(before,after,s);
  if(equal(domain(after),domain(initial)))return 'compensation';
  if(a===undefined){if(s.kind!=='delete-provider')throw fail('MANAGED_MODEL_PROVIDER_DELETE_UNBOUND');return 'change';}
  if(!plain(a)||!Array.isArray(a.models))throw fail('MANAGED_MODEL_PROVIDER_INVALID');
  if(b){const allow=s.kind==='update-provider'?['baseUrl','api','apiKey','models']:['models'];
    if(!equal(omit(b,allow),omit(a,allow)))throw fail('MANAGED_MODEL_PROVIDER_AUTHORITY_CHANGED');
    if(s.kind==='update-provider'){
      if(!equal(b.models,a.models))throw fail('MANAGED_MODEL_MODEL_UNBOUND');
      if(!equal(b.apiKey,a.apiKey)&&!(s.patch.clearApiKey===true&&a.apiKey===undefined))throw fail('MANAGED_MODEL_PROVIDER_SECRET_AUTHORITY_UNAVAILABLE');
      for(const k of ['baseUrl','api'])if(!equal(b[k],a[k])&&!(k==='baseUrl'&&s.patch.clearBaseUrl===true&&a[k]===undefined)&&a[k]!==s.patch[k])throw fail('MANAGED_MODEL_PROVIDER_UNBOUND');
    }
  }else if(s.kind!=='create'||s.providerMode!=='new'||Object.keys(a).some(k=>!['models','baseUrl','api','apiKey'].includes(k))||a.baseUrl!==s.baseUrl||a.api!==(s.api||'openai-completions'))throw fail('MANAGED_MODEL_PROVIDER_CREATE_UNBOUND');
  const ids=new Set([s.sourceModelId,s.model?.id].filter(Boolean));
  const old=b?.models||[],next=a.models;
  if(!equal(old.filter(m=>!ids.has(m.id)),next.filter(m=>!ids.has(m.id)))||new Set(next.map(m=>m.id)).size!==next.length)throw fail('MANAGED_MODEL_MODEL_UNBOUND');
  for(const m of next.filter(m=>ids.has(m.id))){const prior=old.find(x=>x.id===m.id);
    if(equal(prior,m))continue;
    if(m.id!==s.model?.id)throw fail('MANAGED_MODEL_MODEL_UNBOUND');
    const original=prior||old.find(x=>x.id===s.sourceModelId)||{};
    const expected={...original,...s.model};if(!expected.name)expected.name=expected.id;
    if(!Array.isArray(expected.input))expected.input=['text'];if(!expected.cost||typeof expected.cost!=='object')expected.cost={input:0,output:0,cacheRead:0,cacheWrite:0};
    if(!equal(m,expected))throw fail('MANAGED_MODEL_MODEL_UNBOUND');
  }
  return 'change';
}
function modelParams(method,params){if(!plain(params))throw fail('MANAGED_MODEL_RPC_INVALID');capture(params);
  const keys=method==='config.set'?['raw','baseHash']:['models.authSetApiKey','models.authLogout'].includes(method)?['provider','agentId',...(params.credentialScope!==undefined?['credentialScope']:[])]:
    method==='config.patch'?['raw','baseHash','replacePaths']:method==='sessions.list'?['limit','offset','cursor']:
    method==='cron.list'?['includeDisabled','limit','cursor']:method==='cron.get'?['id','expectedVersion','leaseToken']:[];
  if(!['config.get','config.patch','config.set','models.authSetApiKey','models.authLogout','models.list','sessions.list','cron.list','cron.get'].includes(method))throw fail('MANAGED_MODEL_RPC_UNSUPPORTED');
  if(Object.keys(params).some(k=>!keys.includes(k)))throw fail('MANAGED_MODEL_RPC_INVALID');
  if(method==='config.patch'&&(!equal(Object.keys(params).sort(),keys.sort())||typeof params.raw!=='string'||Buffer.byteLength(params.raw)>1024*1024||!HASH.test(params.baseHash)
    ||!Array.isArray(params.replacePaths)||!equal(params.replacePaths,[...new Set(params.replacePaths)].sort())||params.replacePaths.some(x=>typeof x!=='string'||!x||x.length>1024)))throw fail('MANAGED_MODEL_RPC_INVALID');
  if(method==='config.set'&&(!equal(Object.keys(params).sort(),keys.sort())||typeof params.raw!=='string'||Buffer.byteLength(params.raw)>1024*1024||!HASH.test(params.baseHash)))throw fail('MANAGED_MODEL_RPC_INVALID');
  if(['models.authSetApiKey','models.authLogout'].includes(method)&&(!equal(Object.keys(params).sort(),keys.sort())||!PROVIDER.test(params.provider)
    ||typeof params.agentId!=='string'||!params.agentId||params.agentId.length>128||/[\0\r\n]/u.test(params.agentId)
    ||params.credentialScope!==undefined&&params.credentialScope!=='provider'))throw fail('MANAGED_MODEL_RPC_INVALID');
  if(params.limit!==undefined&&(!Number.isSafeInteger(params.limit)||params.limit<1||params.limit>500)||params.offset!==undefined&&(!Number.isSafeInteger(params.offset)||params.offset<0)
    ||params.cursor!==undefined&&(typeof params.cursor!=='string'||params.cursor.length>1024)||params.includeDisabled!==undefined&&typeof params.includeDisabled!=='boolean'
    ||method==='cron.get'&&(typeof params.id!=='string'||!params.id||params.id.length>256))throw fail('MANAGED_MODEL_RPC_INVALID');return true;
}
function nativeModelProjection(config){const result=JSON.parse(JSON.stringify(Object.fromEntries(['models','agents'].filter(k=>Object.hasOwn(config,k)).map(k=>[k,config[k]]))));
  for(const provider of Object.values(result.models?.providers||{}))if(plain(provider))delete provider.apiKey;return result;}
function validateNativeDraft(before,submitted,s){
  if(!plain(submitted)||Object.keys(submitted).some(k=>!['models','agents'].includes(k)))throw fail('MANAGED_MODEL_OWNED_CONFIG_CHANGED');
  const expected=require('./core/openclaw-model-config-draft').buildOpenClawModelDraft(before,s).config;
  if(!equal(nativeModelProjection(expected),submitted))throw fail('MANAGED_MODEL_MODEL_UNBOUND');return expected;
}
function nativeTargetMatches(config,s,initial){
  const expected=require('./core/openclaw-model-config-draft').buildOpenClawModelDraft(initial,s).config;
  return equal(nativeModelProjection(config),nativeModelProjection(expected));
}
function validateNativeAuthMutation(before,after,providerKey,receipt){
  if(!equal(omit(before,['models','auth','meta']),omit(after,['models','auth','meta'])))throw fail('MANAGED_MODEL_OWNED_CONFIG_CHANGED');
  const b=JSON.parse(JSON.stringify(before.models||{})),a=JSON.parse(JSON.stringify(after.models||{}));
  const normalized=providerKey.toLowerCase(),configKey=Object.keys(b.providers||{}).find(key=>key.toLowerCase()===normalized)||providerKey;
  if(b.providers?.[configKey])delete b.providers[configKey].apiKey;
  if(a.providers?.[configKey])delete a.providers[configKey].apiKey;
  if(!equal(b,a))throw fail('MANAGED_MODEL_OTHER_PROVIDER_CHANGED');
  const ids=receipt.profileIds|| (receipt.profileId?[receipt.profileId]:receipt.removedProfiles);
  if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id||id.length>512||/[\0\r\n]/u.test(id)))throw fail('MANAGED_MODEL_CREDENTIAL_RECEIPT_INVALID');
  if(!equal(omit(before.auth,['profiles','order']),omit(after.auth,['profiles','order']))
    ||!equal(omit(before.auth?.profiles,ids),omit(after.auth?.profiles,ids))
    ||!equal(omit(before.auth?.order,[normalized]),omit(after.auth?.order,[normalized])))throw fail('MANAGED_MODEL_PROVIDER_AUTHORITY_CHANGED');
  return true;
}
function targetMatches(config,catalog,s,{retired=false}={}){
  const provider=config.models?.providers?.[s.providerKey];const configured=provider?.models||[];const rows=Array.isArray(catalog?.models)?catalog.models:[];
  const present=id=>rows.some(row=>row?.id===s.providerKey+'/'+id||row?.provider===s.providerKey&&row?.id===id);
  if(s.kind==='delete-provider')return !provider&&!rows.some(row=>row.provider===s.providerKey||row.id?.startsWith(s.providerKey+'/'));
  if(s.kind==='delete-model')return !configured.some(m=>m.id===s.sourceModelId)&&!present(s.sourceModelId);
  if(s.kind==='update-provider')return !!provider&&['baseUrl','api'].every(k=>s.patch?.[k]===undefined||provider[k]===s.patch[k])&&(!s.patch?.clearBaseUrl||provider.baseUrl===undefined)&&(!s.patch?.clearApiKey||provider.apiKey===undefined);
  const entry=configured.find(m=>m.id===s.model?.id);const published=rows.find(row=>row?.id===s.providerKey+'/'+s.model?.id||row?.provider===s.providerKey&&row?.id===s.model?.id);
  if(!entry||!published)return false;
  if(retired&&s.kind==='rename'&&(configured.some(m=>m.id===s.sourceModelId)||present(s.sourceModelId)))return false;
  // These fields are projected by the pinned prepared model catalog. File
  // equality alone cannot substitute for the actual published target runtime.
  return Object.entries(s.model).every(([k,v])=>equal(entry[k],v))
    &&['name','contextWindow','reasoning'].every(k=>!Object.hasOwn(s.model,k)||equal(published[k],s.model[k]));
}
// Only the trusted supervisor supplies this closure. It adds constraints; it
// cannot mint a lease or replace assertModel's token/writer/fence checks.
function leaseContext(context,lease,isCurrent){
  if(!context||!Number.isSafeInteger(context.deadlineAt)||!lease||!Number.isSafeInteger(lease.expiresAt)
    ||typeof isCurrent!=='function'||context.assertCurrent!==undefined&&typeof context.assertCurrent!=='function')throw fail('MANAGED_MODEL_LEASE_INVALID');
  const deadlineAt=Math.min(context.deadlineAt,lease.expiresAt);
  return {...context,deadlineAt,assertCurrent(){
    const result=context.assertCurrent?.();
    if(result&&typeof result.then==='function')throw fail('MANAGED_MODEL_LEASE_INVALID');
    if(context.signal?.aborted||isCurrent()!==true||lease.retired||lease.expiresAt<=Date.now()||deadlineAt<=Date.now())throw fail('MANAGED_MODEL_LEASE_INVALID');
  }};
}
module.exports={plain,capture,spec,wireSpec,restoreSpec,identity,digestMatches,domain,equal,validatePatch,modelParams,targetMatches,nativeModelProjection,validateNativeDraft,nativeTargetMatches,validateNativeAuthMutation,leaseContext,fail,HASH,OP};
