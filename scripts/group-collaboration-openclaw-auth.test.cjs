'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {selectStoredAuthority,selectExistingAuthority}=require('./group-collaboration-openclaw-auth.cjs');
const actualOrder=require('/opt/homebrew/lib/node_modules/openclaw/dist/order-BsYOMdUo.mjs').a;
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),vm=require('node:vm');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const base=()=>({config:{models:{providers:{sample:{baseUrl:'http://127.0.0.1:1/v1',api:'openai-completions',apiKey:'WRONG_INLINE'}}},auth:{profiles:{'sample:default':{provider:'sample',mode:'api_key'}}}},store:{version:1,profiles:{'sample:default':{provider:'sample',type:'api_key',key:'SELECTED_SYNTHETIC_KEY'},'other:default':{provider:'other',type:'api_key',key:'UNSELECTED_SYNTHETIC_KEY'}}},provider:'sample',model:'sample/fixture',resolveOrder:actualOrder});
test('installed SDK order selects only the configured provider profile and overrides stale inline key',()=>{const b=base(),s=selectStoredAuthority(b),target={...b.config.models.providers.sample};s.applyToProvider(target);assert.equal(target.apiKey,'SELECTED_SYNTHETIC_KEY');assert.equal(s.evidence.profileIdDigest,digest('sample:default'));assert.equal(s.evidence.orderedEligibleProfileCount,1);assert.equal(s.evidence.inlineCredentialDiffers,true);assert.equal(JSON.stringify(s).includes('SELECTED_SYNTHETIC_KEY'),false);assert.equal(JSON.stringify(s).includes('UNSELECTED_SYNTHETIC_KEY'),false);assert.equal(b.config.models.providers.sample.apiKey,'WRONG_INLINE');});
test('SDK stored order select the same authority as the original order API',()=>{const b=base();b.config.auth.profiles['sample:second']={provider:'sample',mode:'api_key'};b.store.profiles['sample:second']={provider:'sample',type:'api_key',key:'SECOND'};b.store.order={sample:['sample:second','sample:default']};const s=selectStoredAuthority(b);assert.equal(s.evidence.profileIdDigest,digest(actualOrder({cfg:b.config,store:b.store,provider:'sample',forModel:'fixture',readinessMode:'read-only'})[0]));s.dispose();});
test('auth order uses the installed execution initial-selection contract',()=>{const b=base();let call;b.resolveOrder=x=>{call=x;return actualOrder(x);};const s=selectStoredAuthority(b);assert.equal(call.includePendingOAuthRefresh,true);assert.equal(call.forModel,undefined);assert.equal(call.readinessMode,'read-only');s.dispose();});
test('selected credential cannot be applied to another endpoint or API',()=>{const b=base(),s=selectStoredAuthority(b);assert.throws(()=>s.applyToProvider({...b.config.models.providers.sample,baseUrl:'http://different.invalid'}),{code:'GROUP_LIVE_OPENCLAW_AUTH_TARGET_SCOPE_MISMATCH'});s.dispose();assert.throws(()=>s.applyToProvider({...b.config.models.providers.sample}),{code:'GROUP_LIVE_OPENCLAW_SELECTED_AUTH_DISPOSED'});});
test('unsupported OAuth and unresolved references stop before materializing config',()=>{for(const change of [{type:'oauth',access:'SYNTHETIC_OAUTH'},{keyRef:{source:'env',provider:'default',id:'KEY'}},{key:'${KEY}'}]){const b=base();Object.assign(b.store.profiles['sample:default'],change);b.resolveOrder=()=>['sample:default'];assert.throws(()=>selectStoredAuthority(b),{code:'GROUP_LIVE_OPENCLAW_SELECTED_PROFILE_UNSUPPORTED'});}});
test('missing or mismatched selected authority fails without trying a different provider',()=>{const b=base();b.resolveOrder=()=>[];assert.throws(()=>selectStoredAuthority(b),{code:'GROUP_LIVE_OPENCLAW_SELECTED_PROFILE_MISSING'});b.resolveOrder=()=>['other:default'];assert.throws(()=>selectStoredAuthority(b),{code:'GROUP_LIVE_OPENCLAW_SELECTED_PROFILE_UNSUPPORTED'});});
test('SDK reader rejects noncanonical or absent scope before loading credentials',()=>{const b=base();assert.throws(()=>selectExistingAuthority({...b,nativeStateDir:'/private/tmp/../tmp',homeDir:'/private/tmp'}),{code:'GROUP_LIVE_OPENCLAW_AUTH_SCOPE_INVALID'});});

function ownedNativeFixture(run){
 const root=fs.mkdtempSync('/private/tmp/sggroup-openclaw-auth-unit-');fs.chmodSync(root,0o700);
 const nativeStateDir=path.join(root,'native'),homeDir=path.join(root,'home'),agentDir=path.join(nativeStateDir,'agents/main/agent');
 fs.mkdirSync(agentDir,{recursive:true,mode:0o700});fs.mkdirSync(homeDir,{mode:0o700});fs.mkdirSync(path.join(nativeStateDir,'state'),{mode:0o700});
 const b=base();b.config.agents={defaults:{model:'sample/fixture'}};
 const configFile=path.join(nativeStateDir,'openclaw.json');fs.writeFileSync(configFile,JSON.stringify(b.config),{mode:0o600});
 const options={config:b.config,provider:b.provider,model:b.model,nativeStateDir,homeDir,root};
 try{return run({root,nativeStateDir,homeDir,agentDir,configFile,options});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
function beforeAnyChild(run){
 const original=cp.spawnSync;let calls=0;
 cp.spawnSync=()=>{calls++;throw new Error('Unexpected child: boundary must reject before SDK authentication');};
 try{run();assert.equal(calls,0,'rejected input must not launch the reader');}finally{cp.spawnSync=original;}
}
test('native config symlink and nonregular entries fail before following private bytes or launching a child',()=>{
 for(const kind of ['symlink','directory'])ownedNativeFixture(({root,configFile,options})=>{
  const foreign=path.join(root,'private-config.json');fs.writeFileSync(foreign,'UNRELATED_SYNTHETIC_PRIVATE_BYTES',{mode:0o600});
  fs.unlinkSync(configFile);if(kind==='symlink')fs.symlinkSync(foreign,configFile);else fs.mkdirSync(configFile,{mode:0o700});
  const open=fs.openSync;let forbiddenOpen=0;
  fs.openSync=function(file,...args){if(file===configFile||file===foreign)forbiddenOpen++;return open.call(this,file,...args);};
  try{beforeAnyChild(()=>assert.throws(()=>selectExistingAuthority(options),{code:'GROUP_LIVE_OPENCLAW_AUTH_NATIVE_FILE_INVALID'}));assert.equal(forbiddenOpen,0,'unsafe config must be rejected before opening');}
  finally{fs.openSync=open;}
  assert.equal(fs.readFileSync(foreign,'utf8'),'UNRELATED_SYNTHETIC_PRIVATE_BYTES');
 });
});
test('auth databases and each WAL/SHM symlink are refused before any child or auth-content read',()=>{
 for(const relative of ['agents/main/agent/openclaw-agent.sqlite','state/openclaw.sqlite'])for(const suffix of ['','-wal','-shm'])ownedNativeFixture(({root,nativeStateDir,options})=>{
  const foreign=path.join(root,'unrelated-auth-data'),alias=path.join(nativeStateDir,relative+suffix);
  fs.writeFileSync(foreign,'FOREIGN_AUTH_PROFILE_POISON',{mode:0o600});fs.symlinkSync(foreign,alias);
  const read=fs.readFileSync;let forbiddenRead=0;
  fs.readFileSync=function(file,...args){if(file===alias||file===foreign)forbiddenRead++;return read.call(this,file,...args);};
  try{beforeAnyChild(()=>assert.throws(()=>selectExistingAuthority(options),{code:'GROUP_LIVE_OPENCLAW_AUTH_NATIVE_FILE_INVALID'}));assert.equal(forbiddenRead,0,'database validation must inspect metadata only');}
  finally{fs.readFileSync=read;}
  assert.equal(fs.readFileSync(foreign,'utf8'),'FOREIGN_AUTH_PROFILE_POISON');
 });
});
test('canonical config is accepted through an owned no-child handshake and cannot inherit repository package context',()=>ownedNativeFixture(({options,configFile})=>{
 const original=cp.spawnSync;let calls=0;
 cp.spawnSync=function(command,args,spawnOptions){
  calls++;assert.equal(command,'/usr/bin/sandbox-exec');assert.deepEqual(spawnOptions.stdio,['ignore','ignore','pipe','pipe']);
  const jobFile=args.at(-1),job=JSON.parse(fs.readFileSync(jobFile,'utf8')),scratch=path.dirname(jobFile),ownedReader=args.at(-2);
  assert.equal(job.configSha256,digest(fs.readFileSync(configFile)));assert.equal(spawnOptions.cwd,scratch);
  assert.equal(ownedReader,path.join(scratch,'group-collaboration-openclaw-auth-reader.cjs'));
  assert(fs.readFileSync(ownedReader).equals(fs.readFileSync(path.join(__dirname,'group-collaboration-openclaw-auth-reader.cjs'))));
  assert(fs.readFileSync(path.join(scratch,'group-collaboration-openclaw-auth.cjs')).equals(fs.readFileSync(path.join(__dirname,'group-collaboration-openclaw-auth.cjs'))));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch,'package.json'),'utf8')),{private:true,type:'commonjs'});
  const policy=fs.readFileSync(args[1],'utf8');assert.equal(policy.includes('(subpath "/private/etc")'),false);
  assert.equal(Object.values(spawnOptions.env).includes('SELECTED_SYNTHETIC_KEY'),false);
  const pid=120001;
  return {pid,status:0,signal:null,stderr:Buffer.alloc(0),output:[null,null,null,Buffer.from(JSON.stringify({version:1,status:'passed',pid,key:'SELECTED_SYNTHETIC_KEY',evidence:{provider:'sample',model:'sample/fixture',sdkFiles:job.sdkFiles},canaryChecks:{}}))]};
 };
 try{const selection=selectExistingAuthority(options),target={...options.config.models.providers.sample};selection.applyToProvider(target);assert.equal(target.apiKey,'SELECTED_SYNTHETIC_KEY');assert.equal(calls,1);assert.equal(JSON.stringify(selection.evidence).includes('SELECTED_SYNTHETIC_KEY'),false);selection.dispose();}
 finally{cp.spawnSync=original;}
}));

async function readerFaultWithoutSdk(error){
 const root='/private/tmp/sggroup-reader-unit',nativeStateDir=path.join(root,'native'),configFile=path.join(nativeStateDir,'openclaw.json'),jobFile=path.join(root,'job.json');
 const config=base().config;config.agents={defaults:{model:'sample/fixture'}};const configBytes=Buffer.from(JSON.stringify(config));
 const job={version:1,root,nativeStateDir,homeDir:path.join(root,'home'),scratch:path.join(root,'scratch'),configFile,configSha256:digest(configBytes),provider:'sample',model:'sample/fixture',sdkFiles:[]};
 const emitted=[],publicModule='store-runtime-j0iCH_e-.mjs';let originalSdkLoads=0,childCalls=0;
 const fileApi={
  readFileSync(file){if(file===jobFile)return Buffer.from(JSON.stringify(job));if(file===configFile)return configBytes;throw new Error('Unexpected non-owned reader access');},
  realpathSync:file=>file,
  lstatSync(file){if(file==='/opt/homebrew/lib/node_modules/openclaw/dist/'+publicModule)return{isFile:()=>true,isSymbolicLink:()=>false};throw Object.assign(new Error('missing fixture module'),{code:'ENOENT'});},
  writeSync(fd,value){assert.equal(fd,3);emitted.push(JSON.parse(value));}
 };
 const fakeProcess={argv:['node','owned-reader',jobFile],env:{},pid:120002};
 const requireFixture=id=>{
  if(id==='node:fs')return fileApi;if(id==='node:path')return path;if(id==='node:crypto')return crypto;
  if(id==='node:child_process'){childCalls++;throw new Error('Child forbidden in this fixture');}
  if(id==='/opt/homebrew/lib/node_modules/openclaw/dist/'+publicModule)return{o(){throw error;}};
  if(id==='/opt/homebrew/lib/node_modules/openclaw/dist/order-BsYOMdUo.mjs')return{a(){return['sample:default'];}};
  originalSdkLoads++;throw new Error('Original SDK import forbidden in this fixture');
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'group-collaboration-openclaw-auth-reader.cjs'),'utf8'),{require:requireFixture,process:fakeProcess,Buffer,console:{log(){assert.fail('reader stdout must remain unused');}},setTimeout,clearTimeout},{filename:'owned-reader-fixture.cjs'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(originalSdkLoads,0);assert.equal(childCalls,0);assert.equal(emitted.length,1);assert.equal(fakeProcess.exitCode,1);return emitted[0];
}
test('restricted reader diagnostics keep known classifications without exporting secret messages, paths, or forged module names',async()=>{
 const secret='UPPERCASE_SYNTHETIC_SECRET',privatePath='/private/tmp/sggroup-private-fixture/private-body.txt',body='PRIVATE_SYNTHETIC_BODY';
 const cause=Object.assign(new Error('unable to open '+privatePath+' '+secret),{code:'ERR_SQLITE_ERROR',errcode:14});
 const error=Object.assign(new Error('Cannot find module '+privatePath+' '+body+' '+secret),{code:'ERR_MODULE_NOT_FOUND',cause});
 error.stack='Error: '+secret+' '+privatePath+'\n at /opt/homebrew/lib/node_modules/openclaw/dist/store-runtime-j0iCH_e-.mjs:1:1\n at /opt/homebrew/lib/node_modules/openclaw/dist/'+secret+'.mjs:2:1';
 const frame=await readerFaultWithoutSdk(error),serialized=JSON.stringify(frame);
 for(const forbidden of [secret,privatePath,body])assert.equal(serialized.includes(forbidden),false,'restricted diagnostics must not disclose a canary');
 assert.equal(frame.errorCode,'ERR_MODULE_NOT_FOUND');assert.equal(frame.failure.stage,'auth-store-load');
 assert.deepEqual(Array.from(frame.failure.chain[0].sdkModules),['store-runtime-j0iCH_e-.mjs']);
 assert(frame.failure.chain[0].kinds.includes('module-load'));assert(frame.failure.chain[1].kinds.includes('sqlite-open'));
 assert.equal(frame.failure.chain[1].nativeCode,14);assert.equal(frame.failure.chain[0].messageDigest,digest(error.message));
});
test('unknown uppercase error code or message cannot bypass the diagnostic enum allowlist',async()=>{
 for(const where of ['code','message']){
  const secret='UPPERCASE_SYNTHETIC_SECRET';const error=Object.assign(new Error(where==='message'?secret:'private failure'),{code:where==='code'?secret:undefined,errcode:987654321});
  error.stack='Error '+secret+' /private/tmp/sggroup-private-fixture/secret.txt';
  const frame=await readerFaultWithoutSdk(error);assert.equal(JSON.stringify(frame).includes(secret),false,'unknown enum-like content must remain hidden');
  assert.equal(frame.errorCode,'GROUP_LIVE_OPENCLAW_READONLY_AUTH_UNAVAILABLE');assert.equal(frame.failure.chain[0].code,null);assert.equal(frame.failure.chain[0].nativeCode,null);
 }
});
