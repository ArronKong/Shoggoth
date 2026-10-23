'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createManagedHermesHostSupervisor,_protocol:p}=require('../app/managed-hermes-host-supervisor');
const root=fs.mkdtempSync('/private/tmp/sgh-hermes-supervisor-unit-');fs.chmodSync(root,0o700);const adapters=path.resolve(__dirname,'../resources/external-plugin-adapters');let tests=0;
function test(fn){fn();tests++;}
try{
 const good=path.join(root,'good');fs.mkdirSync(good,{mode:0o700});const supervisor=createManagedHermesHostSupervisor({stateDir:good,adapterResourcesRoot:adapters,serviceUserDataRoot:root});
 test(()=>assert.equal(supervisor.getStatus().ownership,'absent'));
 test(()=>assert.equal(supervisor.getEndpoint(),null));
 const profiles=path.join(supervisor.getStatus().dataRoot,'profiles');test(()=>assert.equal(fs.lstatSync(profiles).mode&0o077,0));
 fs.chmodSync(profiles,0o755);test(()=>assert.throws(()=>createManagedHermesHostSupervisor({stateDir:good,adapterResourcesRoot:adapters,serviceUserDataRoot:root}),{code:'MANAGED_HERMES_PRIVATE_PATH_UNSAFE'}));fs.chmodSync(profiles,0o700);
 const retiredProfiles=profiles+'-original';fs.renameSync(profiles,retiredProfiles);fs.symlinkSync(retiredProfiles,profiles);test(()=>assert.throws(()=>createManagedHermesHostSupervisor({stateDir:good,adapterResourcesRoot:adapters,serviceUserDataRoot:root}),{code:'MANAGED_HERMES_PRIVATE_PATH_UNSAFE'}));fs.unlinkSync(profiles);fs.renameSync(retiredProfiles,profiles);
 test(()=>assert.throws(()=>createManagedHermesHostSupervisor({stateDir:good,adapterResourcesRoot:adapters,serviceUserDataRoot:root,inputPins:{ready:true}}),e=>e.code==='MANAGED_HERMES_OPTIONS_INVALID'));
 const getter={stateDir:good,adapterResourcesRoot:adapters,serviceUserDataRoot:root};Object.defineProperty(getter,'getHermesConfiguration',{enumerable:true,get(){throw Error('getter evaluated');}});
 test(()=>assert.throws(()=>createManagedHermesHostSupervisor(getter),e=>e.code==='MANAGED_HERMES_OPTIONS_INVALID'));
 const alias=path.join(root,'alias');fs.symlinkSync(good,alias);test(()=>assert.throws(()=>createManagedHermesHostSupervisor({stateDir:alias,adapterResourcesRoot:adapters,serviceUserDataRoot:root}),e=>e.code==='MANAGED_HERMES_PRIVATE_PATH_UNSAFE'));
 const home=supervisor.getStatus().dataRoot;const unknown=path.join(home,'parent-writer.fence');fs.writeFileSync(unknown,'{}',{mode:0o600});test(()=>assert.equal(createManagedHermesHostSupervisor({stateDir:good,adapterResourcesRoot:adapters,serviceUserDataRoot:root}).getStatus().ownership,'unknown'));fs.unlinkSync(unknown);
 const python=path.join(home,'shoggoth-managed-writer.fence');fs.writeFileSync(python,'{}',{mode:0o600});test(()=>assert.equal(supervisor.getStatus().ownership,'unknown'));fs.unlinkSync(python);
 const id={pid:77,startIdentity:'actual start',nonce:'a'.repeat(64)},w={identity:id,runtimeRoot:'/private/owned/runtime',runtimeTreeSha256:'b'.repeat(64),proof:null};
 const c={operationId:'unit-op'},snapshot={complete:true,idle:true,running:0,queued:0,building:0,active_work:0,active_model_turns:0,active_model_identities:[],unknown_queued:0,reason:null};
 const proof={version:1,protocol:'hermes-managed-v1',backend_id:'hermes',pid:77,start_identity:id.startIdentity,nonce:id.nonce,generation:'c'.repeat(64),runtime_root:w.runtimeRoot,runtime_tree_sha256:w.runtimeTreeSha256,data_root:home,adapter_tree_sha256:'d'.repeat(64),selection_supported:true,adapter_generation:'adapter-gen',paused:true,snapshot,operation_id:'unit-op'};
 test(()=>assert(p.validProof(proof,c,w,home,'d'.repeat(64))));
 for(const mutation of [{pid:78},{start_identity:'neighbor'},{operation_id:'neighbor-op'},{nonce:'e'.repeat(64)},{generation:true},{runtime_root:'/other'},{data_root:'/other'},{adapter_tree_sha256:'f'.repeat(64)},{snapshot:{...snapshot,running:1}},{snapshot:{...snapshot,complete:false}},{snapshot:{...snapshot,active_model_turns:1}}])test(()=>assert.equal(p.validProof({...proof,...mutation},c,w,home,'d'.repeat(64)),false));
 test(()=>assert.equal(p.validProof({...proof,extra:true},c,w,home,'d'.repeat(64)),false));
 const privateFile=path.join(root,'private.json');fs.writeFileSync(privateFile,'{}',{mode:0o600});const fileLink=path.join(root,'private-link');fs.symlinkSync(privateFile,fileLink);test(()=>assert.throws(()=>p.readPrivate(fileLink),e=>e.code==='MANAGED_HERMES_PRIVATE_FILE_UNSAFE'));
 test(()=>assert.throws(()=>p.guard({operationId:'unit-op',deadlineAt:Date.now()-1}),e=>e.code==='MANAGED_HERMES_DEADLINE_EXPIRED'));
 console.log(JSON.stringify({status:'PASS',tests,hostStarts:0,globalWrites:0}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
