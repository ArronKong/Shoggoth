// Private authenticated core methods, available while ordinary admission is closed.
import { authorizeManagedControl, managedRuntimeIdentity, pauseManagedRuntime,
  resumeManagedRuntime, retireManagedRuntime } from './shoggoth-managed-admission.mjs';
import { notifyManagedGatewayAdmissionChange } from './gateway-work-admission-8IGGoS0B.mjs';
import { t as createGatewayActiveWorkSnapshot } from './gateway-active-work-OAr0e9ce.mjs';
import { t as createGatewayServerActiveWorkInspectors } from './server-active-work-DMRG0p1i.mjs';
import { l as getSelectionRegistrationRegistry } from './runtime-D_mv_Ppq.mjs';
import { selectionCapabilities } from './shoggoth-capability-selection.mjs';
import { t as ErrorCodes } from './gateway-error-details-DkZaR0kI.mjs';
import { f as errorShape } from './error-codes-CvRR89D5.mjs';
const modelReadBindings=new Map();
const snapshot = context => createGatewayActiveWorkSnapshot(createGatewayServerActiveWorkInspectors(context));
const proof = context => {
  const selection = selectionCapabilities(getSelectionRegistrationRegistry());
  const adapters = selection.adapters.filter(item => item.adapterId === 'shoggoth-shared-capabilities');
  return { ...managedRuntimeIdentity(), modelReadProtocol:'openclaw-model-read-v1', snapshot:snapshot(context), selectionSupported:adapters.length===1,
    adapterGeneration:adapters.length===1 ? adapters[0].adapterGeneration : null,
    adapterInstanceId:adapters.length===1 ? adapters[0].instanceId : null };
};
const handler = (kind, callback) => ({params,respond,context}) => {
  try { authorizeManagedControl(params,kind!=='status' && kind!=='retire');
    callback?.(params,context); respond(true,proof(context)); }
  catch(error) { respond(false,undefined,errorShape(ErrorCodes.UNAVAILABLE,error.code||'MANAGED_RUNTIME_CONTROL_FAILED')); }
};
const READ_METHODS=new Set(['models.list','config.get','sessions.list','cron.list','cron.get']);
function readParams(method,params){
  if(!params||Object.getPrototypeOf(params)!==Object.prototype)throw Object.assign(new Error('MANAGED_MODEL_READ_PARAMS_INVALID'),{code:'MANAGED_MODEL_READ_PARAMS_INVALID'});
  const keys=method==='sessions.list'?['limit','offset','cursor']:method==='cron.list'?['includeDisabled','limit','cursor']:method==='cron.get'?['id','expectedVersion','leaseToken']:[];
  if(Object.keys(params).some(k=>!keys.includes(k)||['__proto__','constructor','prototype'].includes(k))
    ||params.limit!==undefined&&(!Number.isSafeInteger(params.limit)||params.limit<1||params.limit>500)
    ||params.offset!==undefined&&(!Number.isSafeInteger(params.offset)||params.offset<0)
    ||params.cursor!==undefined&&(typeof params.cursor!=='string'||params.cursor.length>1024)
    ||params.includeDisabled!==undefined&&typeof params.includeDisabled!=='boolean'
    ||method==='cron.get'&&(typeof params.id!=='string'||!params.id||params.id.length>256))throw Object.assign(new Error('MANAGED_MODEL_READ_PARAMS_INVALID'),{code:'MANAGED_MODEL_READ_PARAMS_INVALID'});
}
const modelRead=async options=>{
  const {params,respond,context,signal}=options;let timer;
  try{
    const keys=['version','controlToken','nonce','operationId','deadlineAt','generation','requestDigest','readMethod','readParams'];
    if(!params||Object.keys(params).length!==keys.length||!keys.every(k=>Object.hasOwn(params,k))
      ||!/^[a-f0-9]{64}$/.test(params.requestDigest)||!READ_METHODS.has(params.readMethod))throw Object.assign(new Error('MANAGED_MODEL_READ_INVALID'),{code:'MANAGED_MODEL_READ_INVALID'});
    const authority=Object.fromEntries(keys.slice(0,6).map(k=>[k,params[k]]));
    const check=()=>{if(signal?.aborted)throw Object.assign(new Error('MANAGED_MODEL_READ_RETIRED'),{code:'MANAGED_MODEL_READ_RETIRED'});
      authorizeManagedControl(authority,true);const actual=proof(context);
      if(!actual.paused||actual.operationId!==params.operationId||!actual.snapshot.idle||!actual.selectionSupported
        ||modelReadBindings.has(params.operationId)&&modelReadBindings.get(params.operationId)!==params.requestDigest)
        throw Object.assign(new Error('MANAGED_MODEL_READ_BINDING_INVALID'),{code:'MANAGED_MODEL_READ_BINDING_INVALID'});
      return actual;};
    readParams(params.readMethod,params.readParams);check();
    if(!modelReadBindings.has(params.operationId)){if(modelReadBindings.size>=128)throw Object.assign(new Error('MANAGED_MODEL_READ_LIMIT'),{code:'MANAGED_MODEL_READ_LIMIT'});
      modelReadBindings.set(params.operationId,params.requestDigest);}
    // Fixed actual upstream handlers only. The normal Gateway admission gate
    // stays closed; this authenticated control path cannot send model work.
    const handler=params.readMethod==='models.list'?(await import('./models-CXtMKHCu.mjs')).modelsHandlers['models.list']:
      params.readMethod==='config.get'?(await import('./config-DCEMZjGn.mjs')).configHandlers['config.get']:
      params.readMethod==='sessions.list'?(await import('./sessions-read-C64Ih-v7.mjs')).sessionReadHandlers['sessions.list']:
      (await import('./cron-DDe3Rbo6.mjs')).cronHandlers[params.readMethod];
    check();if(typeof handler!=='function')throw Object.assign(new Error('MANAGED_MODEL_READ_UNSUPPORTED'),{code:'MANAGED_MODEL_READ_UNSUPPORTED'});
    const value=await Promise.race([new Promise((resolve,reject)=>{
      Promise.resolve(handler({...options,req:{...options.req,method:params.readMethod,params:params.readParams},params:params.readParams,
        respond:(ok,result,error)=>{if(ok)resolve(result);else reject(Object.assign(new Error('MANAGED_MODEL_READ_FAILED'),{code:error?.code||'MANAGED_MODEL_READ_FAILED'}));}})).catch(reject);
    }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('MANAGED_MODEL_READ_TIMEOUT'),{code:'MANAGED_MODEL_READ_TIMEOUT'})),Math.max(1,params.deadlineAt-Date.now()));})]);
    const actual=check();respond(true,{proof:actual,requestDigest:params.requestDigest,readMethod:params.readMethod,value});
  }catch(error){respond(false,undefined,errorShape(ErrorCodes.UNAVAILABLE,error.code||'MANAGED_MODEL_READ_FAILED'));}
  finally{clearTimeout(timer);}
};
export const managedRuntimeHandlers = {
  'gateway.shoggoth.managed.model.read':modelRead,
  'gateway.shoggoth.managed.status':handler('status'),
  'gateway.shoggoth.managed.pause':handler('pause',(params,context)=>{
    pauseManagedRuntime(params); context.cron.pauseScheduling(); notifyManagedGatewayAdmissionChange();
  }),
  'gateway.shoggoth.managed.resume':handler('resume',(params,context)=>{
    const actual=proof(context);
    if (!actual.paused || !actual.snapshot.idle || !actual.selectionSupported) throw Object.assign(new Error('MANAGED_RUNTIME_NOT_IDLE'),{code:'MANAGED_RUNTIME_NOT_IDLE'});
    authorizeManagedControl(params,true);
    context.cron.resumeScheduling();
    resumeManagedRuntime(params); notifyManagedGatewayAdmissionChange();
  }),
  'gateway.shoggoth.managed.retire':handler('retire',(params,context)=>{
    retireManagedRuntime(params); context.cron.pauseScheduling(); notifyManagedGatewayAdmissionChange();
  }),
};
