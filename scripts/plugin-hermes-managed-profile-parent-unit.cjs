'use strict';
// Real sealed Python/profile implementation with normal 022 child umask;
// no serve/model, no aliases, no global home/profile mutations.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createManagedHermesHostSupervisor}=require('../app/managed-hermes-host-supervisor');
const {createManagedPluginHostRuntimeManager}=require('../app/managed-plugin-host-runtime');
const pins=require('../app/managed-hermes-runtime-pins.json');const repo=path.resolve(__dirname,'..');
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sgh-hermes-profile-parent-'));fs.chmodSync(root,0o700);
try{
 const manager=createManagedPluginHostRuntimeManager({stateDir:'/private/tmp/shoggoth-hermes-test-candidate/worker-cache',resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),inputPins:pins});
 const candidate=manager.getCandidate('hermes');assert(candidate);assert.equal(candidate.runtimeTreeSha256,pins.hosts.hermes.outputTreeSha256);
 const stateDir=path.join(root,'app-state');fs.mkdirSync(stateDir,{mode:0o700});
 const host=createManagedHermesHostSupervisor({stateDir,serviceUserDataRoot:root,adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters')});
 const dataRoot=host.getStatus().dataRoot,profiles=path.join(dataRoot,'profiles'),config=path.join(dataRoot,'config.yaml');
 fs.writeFileSync(config,JSON.stringify({model:{default:'local-not-called',provider:'custom'},plugins:{enabled:[]}}),{mode:0o600});
 const before=process.umask();
 const program='import os,json;os.umask(0o022);from hermes_cli.profiles import create_profile;result=create_profile("proof-named",no_alias=True,no_skills=True);print(json.dumps({"profile":str(result)}))';
 execFileSync(candidate.launch.executable,['-B','-c',program],{cwd:candidate.runtimeRoot,env:{HOME:root,HERMES_HOME:dataRoot,PYTHONPATH:candidate.runtimeRoot,PYTHONHOME:'',PYTHONDONTWRITEBYTECODE:'1',PATH:'/usr/bin:/bin'},timeout:20000,maxBuffer:8192,stdio:['ignore','pipe','pipe']});
 assert.equal(process.umask(),before);assert.equal(fs.lstatSync(profiles).mode&0o077,0);
 const named=path.join(profiles,'proof-named');assert.equal(fs.lstatSync(named).mode&0o077,0);assert.equal(fs.lstatSync(path.join(named,'config.yaml')).mode&0o077,0);
 assert.equal(host.getStatus().ownership,'absent');console.log(JSON.stringify({status:'PASS',groups:3,actualPythonProfileCreate:true,normalChildUmask:'022',parentPrivate:true,namedProfilePrivate:true,configPrivate:true,appUmaskUnchanged:true,hostStarts:0,modelRequests:0,globalWrites:0}));
}finally{const walk=d=>{if(!fs.existsSync(d)||!fs.lstatSync(d).isDirectory()||fs.lstatSync(d).isSymbolicLink())return;fs.chmodSync(d,0o700);for(const n of fs.readdirSync(d))walk(path.join(d,n));};walk(root);fs.rmSync(root,{recursive:true,force:true});}
