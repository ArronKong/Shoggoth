'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const net=require('node:net');
const {fork}=require('node:child_process');const {pathToFileURL}=require('node:url');
const repo=path.resolve(__dirname,'..');const {createManagedOpenClawHostClient,_protocol:p}=require(path.join(repo,'app/managed-openclaw-host-client'));
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-oc-service-'));fs.chmodSync(root,0o700);
const adapterUrl=pathToFileURL(path.join(repo,'resources/external-plugin-adapters/openclaw/transport.mjs')).href;
const {createManagedOpenClawHostSupervisor}=require(path.join(repo,'app/managed-openclaw-host-supervisor'));
const cases=[];const servers=[];let count=0;
const mkdir=value=>{fs.mkdirSync(value,{recursive:true,mode:0o700});return value;};
const privateJson=(file,value)=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
const driver=`import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
const spec=JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'fixture.json')));
// Legacy home lookup is explicitly projected onto a disposable test home. No
// test reads the real user's default App credentials or changes product code.
if(spec.legacyHome)os.userInfo=()=>({homedir:spec.legacyHome});
try{const transport=await import(spec.transportUrl);process.send({phase:'ready'});
process.once('message',async()=>{try{if(spec.changeEnv)process.env.SHOGGOTH_SERVICE_USER_DATA_ROOT=spec.changeEnv;
 let result;if(spec.action==='read'){const token=transport.readCredential();result={credentialMatched:token===spec.expectedToken};}
 else if(spec.action==='request')result=await transport.request('fixture.read',{}, {timeoutMs:2000});
 else{const token=transport.readCredential();result=await transport.request('fixture.read',{credentialToken:token},{timeoutMs:2000});}
 process.send({phase:'result',ok:true,result});}catch(error){process.send({phase:'result',ok:false,error:error.message});}finally{process.disconnect();}});
}catch(error){process.send({phase:'import',ok:false,error:error.message});process.disconnect();}`;
function profile(name,token){const dir=mkdir(path.join(root,name));mkdir(path.join(dir,'run'));mkdir(path.join(dir,'shoggoth-core'));
 privateJson(path.join(dir,'shoggoth-core/external-plugin-openclaw.auth.json'),{schemaVersion:1,token});return dir;}
function fixture({serviceRoot,action='both',changeEnv,legacyHome,managed=true}={}){
 const dir=mkdir(path.join(root,'f'+(++count)));const dataRoot=mkdir(path.join(dir,'data'));const runtimeRoot=mkdir(path.join(dir,'runtime'));
 mkdir(path.join(dataRoot,'state'));const entry=path.join(runtimeRoot,'openclaw.mjs');fs.writeFileSync(entry,driver,{mode:0o600});
 const descriptor={version:1,protocol:'openclaw-managed-v1',backendId:'openclaw',nonce:'1'.repeat(64),operationId:'root-fixture',runtimeRoot,
  runtimeTreeSha256:'2'.repeat(64),dataRoot,controlToken:'3'.repeat(64)};
 const descriptorPath=path.join(dataRoot,'managed-control.json');privateJson(descriptorPath,descriptor);
 const spec={transportUrl:adapterUrl,action,expectedToken:'A'.repeat(43)};if(changeEnv)spec.changeEnv=changeEnv;if(legacyHome)spec.legacyHome=legacyHome;
 privateJson(path.join(runtimeRoot,'fixture.json'),spec);
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',OPENCLAW_STATE_DIR:path.join(dataRoot,'state'),OPENCLAW_CONFIG_PATH:path.join(dataRoot,'openclaw.json')};
 if(managed)env.OPENCLAW_SHOGGOTH_MANAGED_DESCRIPTOR=descriptorPath;if(serviceRoot!==undefined)env.SHOGGOTH_SERVICE_USER_DATA_ROOT=serviceRoot;
 return {dir,dataRoot,runtimeRoot,entry,descriptor,descriptorPath,env};
}
async function run(f,beforeUse){let child;const messages=[];let output='';let result;
 await new Promise((resolve,reject)=>{child=fork(f.entry,[],{execPath:process.execPath,env:f.env,stdio:['ignore','pipe','pipe','ipc']});
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('owned disposable transport child timed out'));},5000);
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('message',message=>{messages.push(message);if(message.phase==='ready')Promise.resolve().then(()=>beforeUse?.()).then(()=>child.send('use'),reject);
   else result=message;});
  child.once('exit',(code,signal)=>{clearTimeout(timer);if(code!==0||signal)reject(Error('transport child exit failed: '+output));else resolve();});
 });assert.ok(result);return result;
}
async function listen(dir,marker,token){let calls=0;const target=path.join(dir,'run/service.sock');const sockets=new Set();
 const server=net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let bytes='';socket.on('data',chunk=>{
  bytes+=chunk;if(!bytes.endsWith('\n'))return;const frame=JSON.parse(bytes);assert.equal(frame.version,11);assert.equal(frame.method,'fixture.read');
  if(token)assert.equal(frame.params.credentialToken,token);calls+=1;socket.end(JSON.stringify({id:frame.id,ok:true,result:{marker}})+'\n');});});
 servers.push({server,sockets});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(target,resolve);});fs.chmodSync(target,0o600);return {calls:()=>calls,target};}
async function main(){try{
 const a=profile('a','A'.repeat(43));const b=profile('b','B'.repeat(43));const sa=await listen(a,'A','A'.repeat(43));const sb=await listen(b,'B','B'.repeat(43));
 const options={stateDir:path.join(root,'client-state'),resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters'),
  sourceRoot:'/opt/homebrew/lib/node_modules/openclaw',interpreterPath:(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')),architecture:'arm64',serviceUserDataRoot:a};
 let created=0;for(const value of [undefined,'relative',a+'/',path.join(root,'missing')])assert.throws(()=>createManagedOpenClawHostClient({...options,serviceUserDataRoot:value,workerFactory:()=>{created++;}}),e=>e.code==='MANAGED_OPENCLAW_SERVICE_ROOT_INVALID');
 const linked=path.join(root,'a-link');fs.symlinkSync(a,linked);assert.throws(()=>p.initFor({...options,serviceUserDataRoot:linked}),e=>e.code==='MANAGED_OPENCLAW_SERVICE_ROOT_INVALID');
 fs.chmodSync(b,0o755);assert.throws(()=>p.initFor({...options,serviceUserDataRoot:b}),e=>e.code==='MANAGED_OPENCLAW_SERVICE_ROOT_INVALID');fs.chmodSync(b,0o700);
 assert.throws(()=>p.argsFor('prepareCandidate',{serviceUserDataRoot:a}),e=>e.code==='MANAGED_WORKER_COMMAND_INVALID');
 assert.throws(()=>p.argsFor('request',{method:'health',params:{},timeoutMs:1000,serviceUserDataRoot:a}),e=>e.code==='MANAGED_WORKER_COMMAND_INVALID');assert.equal(created,0);
 cases.push('trusted init requires existing canonical private Service root; missing/noncanonical/symlink/unsafe modes fail before Worker, and command/renderer path overrides are closed');
 const absentState=path.join(root,'host-no-root');assert.throws(()=>createManagedOpenClawHostSupervisor({stateDir:absentState,adapterResourcesRoot:options.adapterResourcesRoot}),e=>e.code==='MANAGED_OPENCLAW_SERVICE_ROOT_INVALID');assert.equal(fs.existsSync(absentState),false);
 const ownedRoot=profile('owned-service','A'.repeat(43));const supervisor=createManagedOpenClawHostSupervisor({stateDir:path.join(root,'owned-host'),adapterResourcesRoot:options.adapterResourcesRoot,serviceUserDataRoot:ownedRoot});
 fs.renameSync(ownedRoot,ownedRoot+'-old');profile('owned-service','A'.repeat(43));
 await assert.rejects(supervisor.controller.startPaused({operationId:'before-spawn',deadlineAt:Date.now()+1000,signal:new AbortController().signal,assertCurrent(){}}),e=>e.code==='MANAGED_OPENCLAW_SERVICE_ROOT_CHANGED');assert.equal(supervisor.getStatus().ownership,'absent');
 cases.push('Supervisor captures true Service root identity: missing binding creates no Host state and replaced same-path root rejects before candidate/fence/spawn effects');
 const positive=await run(fixture({serviceRoot:a,changeEnv:b}));assert.deepEqual(positive,{phase:'result',ok:true,result:{marker:'A'}});assert.equal(sa.calls(),1);assert.equal(sb.calls(),0);
 cases.push('production transport imports exact managed descriptor and freezes actual Service profile; real Unix socket reads original credential/root after environment mutation, with zero other-profile IPC');
 for(const mutate of [()=>{},f=>{f.env.SHOGGOTH_SERVICE_USER_DATA_ROOT='';},f=>{f.env.SHOGGOTH_SERVICE_USER_DATA_ROOT='relative';},f=>{f.env.SHOGGOTH_SERVICE_USER_DATA_ROOT=linked;}]){
  const f=fixture();mutate(f);const result=await run(f);assert.equal(result.phase,'import');assert.equal(result.ok,false);}
 assert.equal(sa.calls(),1);assert.equal(sb.calls(),0);cases.push('managed missing/empty/relative/linked Service root refuses module loading without default-root fallback or IPC');
 for(const mutate of [f=>{f.descriptor.backendId='hermes';privateJson(f.descriptorPath,f.descriptor);},f=>{f.descriptor.extra=true;privateJson(f.descriptorPath,f.descriptor);},
  f=>{f.env.OPENCLAW_STATE_DIR=path.join(f.dir,'other');},f=>{f.descriptor.runtimeRoot=f.dataRoot;privateJson(f.descriptorPath,f.descriptor);},
  f=>{fs.chmodSync(f.descriptorPath,0o644);},f=>{const old=f.descriptorPath+'.old';fs.renameSync(f.descriptorPath,old);fs.symlinkSync(old,f.descriptorPath);}]){
  const f=fixture({serviceRoot:a});mutate(f);const result=await run(f);assert.equal(result.phase,'import');assert.equal(result.ok,false);}
 cases.push('closed descriptor/backend/private record/actual entry and physical state owner checks reject unrelated host, extra fields, escaped entry, wrong state, public descriptor and descriptor symlink');
 const r=profile('r','A'.repeat(43));const sr=await listen(r,'R');const frozen=await run(fixture({serviceRoot:r,action:'request'}),()=>{fs.renameSync(r,r+'-old');profile('r','A'.repeat(43));});
 assert.equal(frozen.ok,false);assert.match(frozen.error,/root changed/);assert.equal(sr.calls(),0);
 cases.push('replacing a frozen Service root with a fresh same-path private directory is rejected by dev/inode before any request');
 const c=profile('c','A'.repeat(43));let bad=await run(fixture({serviceRoot:c,action:'read'}),()=>{const core=path.join(c,'shoggoth-core');fs.renameSync(core,core+'-old');fs.symlinkSync(core+'-old',core);});assert.equal(bad.ok,false);
 const d=profile('d','A'.repeat(43));bad=await run(fixture({serviceRoot:d,action:'read'}),()=>fs.chmodSync(path.join(d,'shoggoth-core'),0o755));assert.equal(bad.ok,false);
 const e=profile('e','A'.repeat(43));bad=await run(fixture({serviceRoot:e,action:'request'}),()=>{fs.rmdirSync(path.join(e,'run'));fs.symlinkSync(path.join(a,'run'),path.join(e,'run'));});assert.equal(bad.ok,false);
 cases.push('private credential/socket parent directories are rechecked and reject symlink escape or unsafe ACL after module loading');
 for(const mutate of [(file)=>{fs.chmodSync(file,0o644);},file=>{const original=file+'.old';fs.renameSync(file,original);fs.symlinkSync(original,file);},
  file=>{fs.linkSync(file,file+'.hardlink');},file=>{fs.writeFileSync(file,' '.repeat(257));}]){
  const dir=profile('credential-'+(++count),'A'.repeat(43));bad=await run(fixture({serviceRoot:dir,action:'read'}),()=>mutate(path.join(dir,'shoggoth-core/external-plugin-openclaw.auth.json')));assert.equal(bad.ok,false);}
 cases.push('credential read preserves owner-only ACL, regular nlink1 and O_NOFOLLOW/dev-inode/size guards; public, linked, hardlinked or oversized files never yield a token');
 const s=profile('socket-'+(++count),'A'.repeat(43));const ss=await listen(s,'S');bad=await run(fixture({serviceRoot:s,action:'request'}),()=>fs.chmodSync(ss.target,0o666));assert.equal(bad.ok,false);assert.equal(ss.calls(),0);
 const t=profile('socket-'+(++count),'A'.repeat(43));fs.symlinkSync(sa.target,path.join(t,'run/service.sock'));bad=await run(fixture({serviceRoot:t,action:'request'}));assert.equal(bad.ok,false);assert.equal(sa.calls(),1);
 cases.push('socket type/ACL/no-symlink validation rejects public or redirected Unix sockets before connect or credential dispatch');
 const legacyHome=mkdir(path.join(root,'legacy-home'));const legacyRoot=mkdir(path.join(legacyHome,'Library/Application Support/Shoggoth'));
 mkdir(path.join(legacyRoot,'run'));mkdir(path.join(legacyRoot,'shoggoth-core'));privateJson(path.join(legacyRoot,'shoggoth-core/external-plugin-openclaw.auth.json'),{schemaVersion:1,token:'A'.repeat(43)});
 const legacy=await listen(legacyRoot,'LEGACY','A'.repeat(43));const old=await run(fixture({managed:false,serviceRoot:b,legacyHome}));assert.deepEqual(old,{phase:'result',ok:true,result:{marker:'LEGACY'}});
 assert.equal(legacy.calls(),1);assert.equal(sb.calls(),0);cases.push('legacy Host without managed descriptor ignores root-only environment; projected disposable pwd home uses original default App namespace, never another profile');
 process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,actualTransport:true,actualUnixSocket:true,hostStarts:0,modelRequests:0,realAccountRequests:0,
  boundary:'actual production adapter transport on disposable Node entry/descriptor and real Unix sockets; not fixed OpenClaw Host/model acceptance; legacy home lookup explicitly projected'})+'\n');
 }finally{for(const {server,sockets} of servers){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}fs.rmSync(root,{recursive:true,force:true});}}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
