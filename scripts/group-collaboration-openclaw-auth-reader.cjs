'use strict';
// Runs only in the evaluation reader's deny-write kernel profile. Credential
// bytes travel on anonymous FD 3, never stdout, environment or an extra file.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const SDK='/opt/homebrew/lib/node_modules/openclaw';
const emit=value=>fs.writeSync(3,JSON.stringify(value));
const safeCodes=new Set(["EPERM","EACCES","ENOENT","ELOOP","ERR_SQLITE_ERROR","ERR_INVALID_PACKAGE_CONFIG","MODULE_NOT_FOUND","ERR_MODULE_NOT_FOUND","ERR_REQUIRE_ASYNC_MODULE","AUTH_PROFILE_MIGRATION_REQUIRED","AUTH_PROFILE_STORE_UNREADABLE","INVALID_SHARED_AUTH_STORE_OWNERSHIP","SHARED_AUTH_STORE_SOURCE_UNREADABLE","GROUP_LIVE_OPENCLAW_READER_JOB_INVALID","GROUP_LIVE_OPENCLAW_SOURCE_CONFIG_CHANGED","GROUP_LIVE_OPENCLAW_READER_MODEL_CHANGED","GROUP_LIVE_OPENCLAW_READER_CANARY_INVALID","GROUP_LIVE_OPENCLAW_READER_KERNEL_CANARY_FAILED","GROUP_LIVE_OPENCLAW_MODEL_UNCONFIRMED","GROUP_LIVE_OPENCLAW_SELECTED_PROFILE_MISSING","GROUP_LIVE_OPENCLAW_SELECTED_PROFILE_UNSUPPORTED","GROUP_LIVE_OPENCLAW_SELECTED_AUTH_DISPOSED","GROUP_LIVE_OPENCLAW_AUTH_TARGET_SCOPE_MISMATCH"]);
const safeCode=value=>typeof value==='string'&&safeCodes.has(value)?value:null;
const publicSdkModule=name=>{try{const file=path.join(SDK,'dist',name),s=fs.lstatSync(file);return s.isFile()&&!s.isSymbolicLink();}catch{return false;}};
let readerStage='job-read';
function safeFailure(error){
 const chain=[];
 for(let e=error,i=0;e&&i<4;e=e.cause,i++){
  const msg=String(e.message||'');
  const kinds=[['permission-denied',/EPERM|EACCES|Operation not permitted|Permission denied/u],['sqlite-readonly',/readonly|read-only database/u],['sqlite-open',/unable to open|Cannot open/u],['sqlite-locked',/database is locked|SQLITE_BUSY/u],['sqlite-schema',/no such table|no such column|schema/u],['module-load',/Cannot find module|ERR_MODULE|ERR_INVALID_PACKAGE_CONFIG/u],['sqlite-unsafe',/SQLite support is unavailable or unsafe/u],['auth-migration',/migration|requires legacy credential/u]].filter(([,re])=>re.test(msg)).map(([kind])=>kind);
  const stack=String(e.stack||'');
  const sdkModules=[...new Set([...stack.matchAll(/\/opt\/homebrew\/lib\/node_modules\/openclaw\/dist\/([A-Za-z0-9_.-]+\.mjs)/gu)].map(m=>m[1]).filter(publicSdkModule))].slice(0,12);
  chain.push({code:safeCode(e.code),nativeCode:Number.isInteger(e.errcode)&&e.errcode>=0&&e.errcode<=255?e.errcode:null,kinds,sdkModules,messageDigest:hash(msg)});
 }
 return {stage:readerStage,chain};
}
async function main(){
 const job=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 if(job.version!==1||!job.root.startsWith('/private/tmp/sggroup-')||fs.realpathSync(job.root)!==job.root||job.configFile!==path.join(job.nativeStateDir,'openclaw.json'))throw new Error('GROUP_LIVE_OPENCLAW_READER_JOB_INVALID');
 readerStage='config-read';const bytes=fs.readFileSync(job.configFile);if(hash(bytes)!==job.configSha256)throw new Error('GROUP_LIVE_OPENCLAW_SOURCE_CONFIG_CHANGED');
 const config=JSON.parse(bytes),configured=typeof config.agents?.defaults?.model==='string'?config.agents.defaults.model:config.agents?.defaults?.model?.primary;
 if(configured!==job.model||job.provider!==job.model.split('/')[0])throw new Error('GROUP_LIVE_OPENCLAW_READER_MODEL_CHANGED');
 const checks={},denied=(name,fn)=>{try{fn();checks[name]=false;}catch(e){checks[name]=e.code==='EPERM'||e.code==='EACCES';}};
 readerStage='kernel-canary';if(job.syntheticCanary){
  if(!job.nativeStateDir.startsWith(job.root+'/')||!job.syntheticCanary.startsWith(job.nativeStateDir+'/'))throw new Error('GROUP_LIVE_OPENCLAW_READER_CANARY_INVALID');
  checks.originalConfigReadable=bytes.length>0;
  if(job.syntheticPrivateFile){if(!job.syntheticPrivateFile.startsWith(job.homeDir+'/'))throw new Error('GROUP_LIVE_OPENCLAW_READER_CANARY_INVALID');denied('privateNonAuthFileReadDenied',()=>fs.readFileSync(job.syntheticPrivateFile));denied('privateNonAuthFileWriteDenied',()=>fs.writeFileSync(job.syntheticPrivateFile,'forbidden'));}
  denied('originalConfigChmodDenied',()=>fs.chmodSync(job.configFile,fs.statSync(job.configFile).mode&0o777));
  denied('originalCanaryWriteDenied',()=>fs.writeFileSync(job.syntheticCanary,'forbidden'));
  denied('originalNewFileDenied',()=>fs.writeFileSync(path.join(job.nativeStateDir,'forbidden-new.txt'),'forbidden'));
  const scratchFile=path.join(job.scratch,'scratch-positive.txt');fs.writeFileSync(scratchFile,'owned-positive');checks.ownedScratchWrite=fs.readFileSync(scratchFile,'utf8')==='owned-positive';
  const fork=require('node:child_process').spawnSync('/bin/cat',[job.configFile]);checks.forkDenied=Boolean(fork.error)||fork.status!==0;
  checks.networkDenied=await new Promise(resolve=>{const socket=require('node:net').connect(443,'1.1.1.1'),timer=setTimeout(()=>{socket.destroy();resolve(false);},2000);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});socket.once('error',e=>{clearTimeout(timer);resolve(e.code==='EPERM'||e.code==='EACCES');});});
  if(!Object.values(checks).every(v=>v===true))throw new Error('GROUP_LIVE_OPENCLAW_READER_KERNEL_CANARY_FAILED');
 }
 readerStage='SDK-load';const load=require(path.join(SDK,'dist/store-runtime-j0iCH_e-.mjs')).o;
 readerStage='order-load';const resolveOrder=require(path.join(SDK,'dist/order-BsYOMdUo.mjs')).a;
 readerStage='auth-store-load';const store=load(path.join(job.nativeStateDir,'agents/main/agent'),{config,readOnly:true,syncExternalCli:false,allowKeychainPrompt:false,migrationProvider:job.provider,externalCli:{providerIds:[],profileIds:[]}},{HOME:job.homeDir,OPENCLAW_HOME:job.nativeStateDir,OPENCLAW_STATE_DIR:job.nativeStateDir,OPENCLAW_CONFIG_PATH:job.configFile});
 readerStage='auth-selection';const selection=require('./group-collaboration-openclaw-auth.cjs').selectStoredAuthority({config,store,provider:job.provider,model:job.model,resolveOrder,sdkFiles:job.sdkFiles});
 const target={...config.models.providers[job.provider]};selection.applyToProvider(target);const key=target.apiKey;delete target.apiKey;selection.dispose();if(job.syntheticCanary)checks.selectedKeyNotInEnvironment=!Object.values(process.env).includes(key);
 readerStage='final-config-observation';if(hash(fs.readFileSync(job.configFile))!==job.configSha256)throw new Error('GROUP_LIVE_OPENCLAW_SOURCE_CONFIG_CHANGED');
 emit({version:1,status:'passed',key,evidence:selection.evidence,pid:process.pid,canaryChecks:checks});
}
main().catch(e=>{emit({version:1,status:'failed',errorCode:safeCode(e.code)??safeCode(e.message)??'GROUP_LIVE_OPENCLAW_READONLY_AUTH_UNAVAILABLE',pid:process.pid,failure:safeFailure(e)});process.exitCode=1;});
