"use strict";
// Pure trusted-continuation guard regression. No Host, worker or authority proof.
const assert=require('node:assert/strict');const {leaseContext}=require('../app/managed-openclaw-model-policy');
const actualNow=Date.now;let now=100000;Date.now=()=>now;
try{
 const cases=[];const abort=new AbortController();const lease={expiresAt:100120,retired:false};let current=lease,parentCalls=0,effects=0;
 const original={deadlineAt:100180,signal:abort.signal,operationId:'original',assertCurrent(){parentCalls+=1;}};
 const bounded=leaseContext(original,lease,()=>current===lease);assert.equal(bounded.deadlineAt,lease.expiresAt);assert.equal(bounded.operationId,'original');
 bounded.assertCurrent();effects+=1;assert.equal(parentCalls,1);assert.equal(effects,1);
 cases.push('trusted effect carries original operation/signal/parent guard and caps continuation deadline to original lease expiry');
 now=100120;assert.throws(()=>{bounded.assertCurrent();effects+=1;},e=>e.code==='MANAGED_MODEL_LEASE_INVALID');assert.equal(effects,1);
 lease.expiresAt=100300;assert.throws(()=>{bounded.assertCurrent();effects+=1;},e=>e.code==='MANAGED_MODEL_LEASE_INVALID');assert.equal(effects,1);
 const renewed=leaseContext(original,lease,()=>current===lease);assert.equal(renewed.deadlineAt,original.deadlineAt);renewed.assertCurrent();
 cases.push('expired old effect cannot execute or revive when later heartbeat renews lease; only a newly bound continuation sees renewed TTL');
 now=100130;lease.retired=true;assert.throws(()=>renewed.assertCurrent(),e=>e.code==='MANAGED_MODEL_LEASE_INVALID');lease.retired=false;current={...lease};
 assert.throws(()=>renewed.assertCurrent(),e=>e.code==='MANAGED_MODEL_LEASE_INVALID');current=lease;
 assert.throws(()=>leaseContext(original,lease,()=>({ready:true})).assertCurrent(),e=>e.code==='MANAGED_MODEL_LEASE_INVALID');
 cases.push('retired token, replacement record and serializable truthy presence cannot authorize a continuation');
 abort.abort();assert.throws(()=>renewed.assertCurrent(),e=>e.code==='MANAGED_MODEL_LEASE_INVALID');
 const stopError=Object.assign(Error('canceled original command'),{code:'MANAGED_WORKER_OPERATION_RETIRED'});
 assert.throws(()=>leaseContext({...original,signal:null,assertCurrent(){throw stopError;}},lease,()=>true).assertCurrent(),e=>e===stopError);
 assert.throws(()=>leaseContext({...original,signal:null,assertCurrent:async()=>true},lease,()=>true).assertCurrent(),e=>e.code==='MANAGED_MODEL_LEASE_INVALID');
 cases.push('original command cancellation and signal remain fatal; async authority callback is not accepted as a completed guard');
 now=100180;const deadline=leaseContext({...original,signal:null,assertCurrent(){}},lease,()=>true);assert.throws(()=>deadline.assertCurrent(),e=>e.code==='MANAGED_MODEL_LEASE_INVALID');
 for(const expiresAt of [undefined,NaN,Infinity,'100300'])assert.throws(()=>leaseContext(original,{expiresAt},()=>true),e=>e.code==='MANAGED_MODEL_LEASE_INVALID');
 cases.push('parent deadline still closes effects after a lease renewal; invalid deadlines cannot build a guard');
 process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,boundary:'pure original-lease continuation policy; no Host/start/resume/deployment claim'})+'\n');
}finally{Date.now=actualNow;}
