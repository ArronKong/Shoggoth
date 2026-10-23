'use strict';
const assert=require('node:assert/strict');const {createManagedConfigSourceLedger}=require('../app/managed-openclaw-config-source-ledger');
const binding={token:'a'.repeat(64),operationId:'owned-model-op',requestDigest:'b'.repeat(64),generation:'generation-one',writerNonce:'c'.repeat(64)};
const source=(hash,ino)=>({hash:hash.repeat(64),identity:{dev:7,ino}});const original=source('d',11),staged=source('e',12),guard=()=>true;
const cases=[];const ledger=createManagedConfigSourceLedger(binding,original);
assert.equal(ledger.loadedHash(binding,original,guard),original.hash);assert.equal(ledger.assertStaged(binding,original,guard),true);
cases.push('exact original owner and captured private source hash/inode are required; ledger proves no Host or writer authority itself');
assert.equal(ledger.recordStagedWrite(binding,original,staged,guard),true);assert.equal(ledger.loadedHash(binding,staged,guard),original.hash);
assert.throws(()=>ledger.loadedHash(binding,original,guard),e=>e.code==='MANAGED_MODEL_CONFIG_SOURCE_MISMATCH');
cases.push('own atomic CAS advances persisted staged hash/inode while actual loaded raw hash stays original; cached Host revision cannot claim the staged file loaded');
for(const foreign of [source('f',12),source('e',99),{hash:staged.hash,identity:{dev:9,ino:12}}])
 assert.throws(()=>ledger.loadedHash(binding,foreign,guard),e=>e.code==='MANAGED_MODEL_CONFIG_SOURCE_MISMATCH');
assert.throws(()=>ledger.recordStagedWrite(binding,staged,source('f',12),guard),e=>e.code==='MANAGED_MODEL_CONFIG_CAS_UNVERIFIED');
cases.push('external bytes, same-byte inode replacement or in-place write cannot be treated as this lease atomic CAS');
for(const key of Object.keys(binding)){const changed={...binding,[key]:key==='operationId'?'another-op':key==='generation'?'generation-two':'f'.repeat(64)};
 assert.throws(()=>ledger.loadedHash(changed,staged,guard),e=>e.code==='MANAGED_MODEL_CONFIG_LEDGER_OWNER_MISMATCH');}
cases.push('old or copied ledger cannot cross token, operation, digest, generation or writer nonce');
const next={...binding,generation:'generation-two',writerNonce:'f'.repeat(64)},reloaded=source('9',13);
for(const bad of [{...next,operationId:'foreign-op'},{...next,requestDigest:'0'.repeat(64)},{...next,token:'0'.repeat(64)},{...next,generation:binding.generation},{...next,writerNonce:binding.writerNonce}])
 assert.throws(()=>ledger.replaceLoadedOwner(binding,bad,staged,reloaded,guard),e=>e.code==='MANAGED_MODEL_CONFIG_LEDGER_OWNER_MISMATCH');
assert.equal(ledger.replaceLoadedOwner(binding,next,staged,reloaded,guard),true);assert.equal(ledger.loadedHash(next,reloaded,guard),reloaded.hash);
assert.throws(()=>ledger.loadedHash(binding,reloaded,guard),e=>e.code==='MANAGED_MODEL_CONFIG_LEDGER_OWNER_MISMATCH');
cases.push('only same original token/op/digest and distinct exact paused owner generation/nonce can reset loaded source after trusted real restart; old binding rejects');
for(const retired of [()=>false,async()=>true,()=>undefined])assert.throws(()=>ledger.loadedHash(next,reloaded,retired),e=>e.code==='MANAGED_MODEL_CONFIG_LEDGER_RETIRED');
let calls=0;assert.throws(()=>ledger.recordStagedWrite(next,reloaded,source('8',14),()=>++calls===1),e=>e.code==='MANAGED_MODEL_CONFIG_LEDGER_RETIRED');
assert.equal(ledger.loadedHash(next,reloaded,guard),reloaded.hash);
cases.push('current per-effect guard must be strict true before and after state transition; expired/canceled continuation cannot publish a new source');
const getter={...binding};Object.defineProperty(getter,'generation',{enumerable:true,get(){throw Error('must not invoke accessor');}});
for(const invalid of [getter,{...binding,extra:true},Object.assign(Object.create({ready:true}),binding),{...binding,token:7}])assert.throws(()=>createManagedConfigSourceLedger(invalid,original));
assert.throws(()=>createManagedConfigSourceLedger(binding,{...original,identity:{dev:7,ino:11,extra:true}}));
cases.push('closed own-data bindings and source records reject accessor, prototype, extra fields or invalid opaque/hash values');
process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,modelRequests:0,globalWrites:0,boundary:'pure private ledger constraints; actual Host HMAC/loading/writer proof remains Supervisor responsibility'})+'\n');
