'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {_protocol:p,createManagedHermesHostClient}=require('../app/managed-hermes-host-client');
const {createManagedHermesHostSupervisor}=require('../app/managed-hermes-host-supervisor');
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sgh-hermes-init-root-'));fs.chmodSync(root,0o700);
const repo=path.resolve(__dirname,'..');const options={stateDir:path.join(root,'manager'),supervisorStateDir:path.join(root,'host'),
 resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters'),
 sourceRoot:'/private/tmp/shoggoth-hermes-test-candidate/input',interpreterPath:'/private/tmp/shoggoth-hermes-test-candidate/input/venv/bin/python',
 architecture:'arm64',serviceUserDataRoot:root};
const cases=[];
try{
 assert.equal(p.serviceRootFor(root),root);assert.equal(p.initFor(options).serviceUserDataRoot,root);
 for(const serviceUserDataRoot of [undefined,'','relative',root+'/',root+'/..'])assert.throws(()=>p.initFor({...options,serviceUserDataRoot}),{code:'MANAGED_HERMES_SERVICE_ROOT_INVALID'});
 cases.push('trusted init requires explicit absolute canonical private Service root');
 const alias=path.join(root,'alias');fs.symlinkSync(root,alias);assert.throws(()=>p.serviceRootFor(alias),{code:'MANAGED_HERMES_SERVICE_ROOT_INVALID'});
 const publicDir=path.join(root,'public');fs.mkdirSync(publicDir,{mode:0o700});fs.chmodSync(publicDir,0o755);assert.throws(()=>p.serviceRootFor(publicDir),{code:'MANAGED_HERMES_SERVICE_ROOT_INVALID'});
 const file=path.join(root,'file');fs.writeFileSync(file,'',{mode:0o600});assert.throws(()=>p.serviceRootFor(file),{code:'MANAGED_HERMES_SERVICE_ROOT_INVALID'});
 cases.push('symlink, shared directory, file and nonexistent binding fail before Worker creation');
 let workers=0;assert.throws(()=>createManagedHermesHostClient({...options,serviceUserDataRoot:alias,workerFactory:()=>workers++}),{code:'MANAGED_HERMES_SERVICE_ROOT_INVALID'});assert.equal(workers,0);
 const accessor={...options};Object.defineProperty(accessor,'serviceUserDataRoot',{enumerable:true,get(){throw Error('getter invoked');}});
 assert.throws(()=>createManagedHermesHostClient(accessor),{code:'MANAGED_WORKER_INIT_INVALID'});
 const supervisor={stateDir:path.join(root,'host'),adapterResourcesRoot:options.adapterResourcesRoot};Object.defineProperty(supervisor,'serviceUserDataRoot',{enumerable:true,get(){throw Error('getter invoked');}});
 assert.throws(()=>createManagedHermesHostSupervisor(supervisor),{code:'MANAGED_HERMES_OPTIONS_INVALID'});
 cases.push('unsafe roots and accessors execute neither caller getter nor Worker/Host startup');
 for(const method of ['prepareCandidate','activateCandidate','request'])assert.throws(()=>p.argsFor(method,{serviceUserDataRoot:root}),{code:'MANAGED_WORKER_COMMAND_INVALID'});
 assert.throws(()=>p.requestParams('selection_dispatch.capabilities',{session_id:'session',serviceUserDataRoot:root}),{code:'MANAGED_WORKER_PARAMS_INVALID'});
 cases.push('request and operation messages cannot replace the trusted init binding');
 console.log(JSON.stringify({status:'PASS',groups:cases.length,cases,hostStarts:0,globalWrites:0}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
