// Managed OpenClaw v1: initial core admission is closed before Gateway startup.
// This is control-plane data; no descriptor, token or proof enters model input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
const fail = code => Object.assign(new Error(code), { code });
const HASH = /^[a-f0-9]{64}$/;
const OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const required = ['version','protocol','backendId','nonce','operationId','runtimeRoot','runtimeTreeSha256','dataRoot','controlToken'];
const enabled = process.argv.includes('gateway') && process.argv.includes('run') || !!process.env.OPENCLAW_SHOGGOTH_MANAGED_DESCRIPTOR;
let descriptor = null;
if (enabled) {
  const file = process.env.OPENCLAW_SHOGGOTH_MANAGED_DESCRIPTOR;
  if (!file || !path.isAbsolute(file)) throw fail('MANAGED_RUNTIME_DESCRIPTOR_REQUIRED');
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8192
      || (before.mode & 0o077) !== 0 || process.getuid && before.uid !== process.getuid()) throw fail('MANAGED_RUNTIME_DESCRIPTOR_UNSAFE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = fs.fstatSync(fd);
    if (actual.dev !== before.dev || actual.ino !== before.ino) throw fail('MANAGED_RUNTIME_DESCRIPTOR_CHANGED');
    descriptor = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail('MANAGED_RUNTIME_DESCRIPTOR_CHANGED');
  } finally { fs.closeSync(fd); }
  if (!descriptor || Object.keys(descriptor).length !== required.length || !required.every(k => Object.hasOwn(descriptor,k))
      || descriptor.version !== 1 || descriptor.protocol !== 'openclaw-managed-v1' || descriptor.backendId !== 'openclaw'
      || !HASH.test(descriptor.nonce) || !HASH.test(descriptor.controlToken) || !HASH.test(descriptor.runtimeTreeSha256)
      || !OP.test(descriptor.operationId)) throw fail('MANAGED_RUNTIME_DESCRIPTOR_INVALID');
  const runtimeRoot = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const home = fs.lstatSync(descriptor.dataRoot);
  if (descriptor.runtimeRoot !== runtimeRoot || fs.realpathSync(descriptor.runtimeRoot) !== runtimeRoot
      || !home.isDirectory() || home.isSymbolicLink() || (home.mode & 0o077) !== 0
      || process.getuid && home.uid !== process.getuid() || fs.realpathSync(descriptor.dataRoot) !== descriptor.dataRoot
      || fs.realpathSync(file) !== path.join(descriptor.dataRoot, 'managed-control.json')) throw fail('MANAGED_RUNTIME_BINDING_INVALID');
  const fencePath = path.join(descriptor.dataRoot, 'writer.fence');
  const fenceStat = fs.lstatSync(fencePath);
  if (!fenceStat.isFile() || fenceStat.isSymbolicLink() || fenceStat.nlink !== 1
      || (fenceStat.mode & 0o077) !== 0 || process.getuid && fenceStat.uid !== process.getuid()) throw fail('MANAGED_RUNTIME_FENCE_INVALID');
  const fence = JSON.parse(fs.readFileSync(fencePath, 'utf8'));
  if (fence.version !== 1 || fence.nonce !== descriptor.nonce || fence.runtimeRoot !== runtimeRoot
      || fence.operationId !== descriptor.operationId) throw fail('MANAGED_RUNTIME_FENCE_INVALID');
  descriptor = Object.freeze(descriptor);
}
const generation = randomUUID();
let paused = enabled;
let operationId = descriptor?.operationId ?? null;
const retired = new Set();
export const isManagedGatewayPaused = () => paused;
export const managedRuntimeIdentity = () => {
  if (!descriptor) throw fail('MANAGED_RUNTIME_UNAVAILABLE');
  return { version:1, protocol:descriptor.protocol, backendId:'openclaw', pid:process.pid,
    nonce:descriptor.nonce, runtimeRoot:descriptor.runtimeRoot, runtimeTreeSha256:descriptor.runtimeTreeSha256,
    dataRoot:descriptor.dataRoot, generation, paused, operationId };
};
export function authorizeManagedControl(params, mutation = false) {
  if (!descriptor) throw fail('MANAGED_RUNTIME_UNAVAILABLE');
  const keys = ['version','controlToken','nonce','operationId','deadlineAt','generation'];
  if (!params || Object.keys(params).length !== keys.length || !keys.every(k=>Object.hasOwn(params,k))
      || params.version !== 1 || !HASH.test(params.controlToken) || !HASH.test(params.nonce)
      || !OP.test(params.operationId) || !Number.isSafeInteger(params.deadlineAt)
      || params.deadlineAt <= Date.now() || params.deadlineAt > Date.now()+60000
      || params.nonce !== descriptor.nonce
      || !timingSafeEqual(Buffer.from(params.controlToken,'hex'),Buffer.from(descriptor.controlToken,'hex'))
      || (mutation ? params.generation !== generation : params.generation !== null && params.generation !== generation)) throw fail('MANAGED_RUNTIME_CONTROL_REJECTED');
  if (mutation && retired.has(params.operationId)) throw fail('MANAGED_RUNTIME_OPERATION_RETIRED');
}
export function pauseManagedRuntime(params) {
  authorizeManagedControl(params,true);
  if (paused && operationId && operationId !== params.operationId) throw fail('MANAGED_RUNTIME_OPERATION_CONFLICT');
  paused = true; operationId = params.operationId;
}
export function resumeManagedRuntime(params) {
  authorizeManagedControl(params,true);
  if (!paused || operationId !== params.operationId) throw fail('MANAGED_RUNTIME_OPERATION_CONFLICT');
  paused = false; operationId = null;
}
export function retireManagedRuntime(params) {
  authorizeManagedControl(params,false);
  retired.add(params.operationId);
  if (retired.size > 128) throw fail('MANAGED_RUNTIME_OPERATION_LIMIT');
  paused = true;
  if (operationId === null) operationId = params.operationId;
}
