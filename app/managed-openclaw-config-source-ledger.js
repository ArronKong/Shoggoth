'use strict';
// This private ledger records this lease's own atomic CAS writes. It does not
// prove Host loading, writer ownership or authority: the Supervisor supplies a
// current guard and verifies the actual Host revision before using loadedHash.
const HASH=/^[a-f0-9]{64}$/;const OPAQUE=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const fail=code=>Object.assign(new Error(code),{code});
const need=(value,code='MANAGED_MODEL_CONFIG_LEDGER_INVALID')=>{if(!value)throw fail(code);};
function plain(value,keys){return value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length
 &&keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d&&d.enumerable&&Object.hasOwn(d,'value');});}
function captureBinding(value){const keys=['token','operationId','requestDigest','generation','writerNonce'];need(plain(value,keys));
 need(keys.every(key=>typeof value[key]==='string')&&HASH.test(value.token)&&HASH.test(value.requestDigest)&&HASH.test(value.writerNonce)&&OPAQUE.test(value.operationId)&&OPAQUE.test(value.generation));
 return Object.freeze(Object.fromEntries(keys.map(key=>[key,value[key]])));}
function captureSource(value){need(plain(value,['hash','identity'])&&typeof value.hash==='string'&&HASH.test(value.hash)&&plain(value.identity,['dev','ino']));
 need(Number.isSafeInteger(value.identity.dev)&&value.identity.dev>=0&&Number.isSafeInteger(value.identity.ino)&&value.identity.ino>0);
 return Object.freeze({hash:value.hash,identity:Object.freeze({...value.identity})});}
const sameBinding=(a,b)=>Object.keys(a).every(key=>a[key]===b[key]);
const sameSource=(a,b)=>a.hash===b.hash&&a.identity.dev===b.identity.dev&&a.identity.ino===b.identity.ino;
function createManagedConfigSourceLedger(binding,source){let owner=captureBinding(binding),staged=captureSource(source),loadedRawHash=staged.hash;
 function current(value,observed,guard){need(typeof guard==='function');need(guard()===true,'MANAGED_MODEL_CONFIG_LEDGER_RETIRED');
  need(sameBinding(owner,captureBinding(value)),'MANAGED_MODEL_CONFIG_LEDGER_OWNER_MISMATCH');const copy=captureSource(observed);
  need(sameSource(staged,copy),'MANAGED_MODEL_CONFIG_SOURCE_MISMATCH');return copy;}
 return Object.freeze({
  assertStaged(binding,source,guard){current(binding,source,guard);return true;},
  loadedHash(binding,source,guard){current(binding,source,guard);return loadedRawHash;},
  recordStagedWrite(binding,before,after,guard){const prior=current(binding,before,guard),next=captureSource(after);
   need(prior.identity.dev!==next.identity.dev||prior.identity.ino!==next.identity.ino,'MANAGED_MODEL_CONFIG_CAS_UNVERIFIED');
   need(guard()===true,'MANAGED_MODEL_CONFIG_LEDGER_RETIRED');staged=next;return true;},
  // Called only after the Supervisor confirms the old writer exited and the
  // same immutable candidate's new paused writer passed exact health guards.
  // The new loaded hash must still pass actual Host HMAC before preparation.
  replaceLoadedOwner(previous,next,before,after,guard){current(previous,before,guard);const replacement=captureBinding(next),source=captureSource(after);
   need(['token','operationId','requestDigest'].every(key=>owner[key]===replacement[key])
    &&owner.generation!==replacement.generation&&owner.writerNonce!==replacement.writerNonce,'MANAGED_MODEL_CONFIG_LEDGER_OWNER_MISMATCH');
   need(guard()===true,'MANAGED_MODEL_CONFIG_LEDGER_RETIRED');owner=replacement;staged=source;loadedRawHash=source.hash;return true;},
 });
}
module.exports={createManagedConfigSourceLedger};
