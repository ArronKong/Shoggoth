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
const snapshot = context => createGatewayActiveWorkSnapshot(createGatewayServerActiveWorkInspectors(context));
const proof = context => {
  const selection = selectionCapabilities(getSelectionRegistrationRegistry());
  const adapters = selection.adapters.filter(item => item.adapterId === 'shoggoth-shared-capabilities');
  return { ...managedRuntimeIdentity(), snapshot:snapshot(context), selectionSupported:adapters.length===1,
    adapterGeneration:adapters.length===1 ? adapters[0].adapterGeneration : null,
    adapterInstanceId:adapters.length===1 ? adapters[0].instanceId : null };
};
const handler = (kind, callback) => ({params,respond,context}) => {
  try { authorizeManagedControl(params,kind!=='status' && kind!=='retire');
    callback?.(params,context); respond(true,proof(context)); }
  catch(error) { respond(false,undefined,errorShape(ErrorCodes.UNAVAILABLE,error.code||'MANAGED_RUNTIME_CONTROL_FAILED')); }
};
export const managedRuntimeHandlers = {
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
