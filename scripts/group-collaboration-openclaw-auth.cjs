'use strict';
// Evaluation-only: read the existing SDK-selected API-key authority without importing
// the original Home as model context. Only that selected key reaches owned config.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SDK = '/opt/homebrew/lib/node_modules/openclaw';
const modules = ['dist/store-runtime-j0iCH_e-.mjs', 'dist/store-BVWJOVBa.mjs', 'dist/order-BsYOMdUo.mjs', 'dist/sqlite-json-B-NT4SVB.mjs', 'dist/gateway-state-owner-YpBfU4aL.mjs', 'dist/paths-CtO6iw0c.mjs', 'dist/openclaw-state-db.paths-rJI64Ab5.mjs', 'dist/pid-alive-BYw_9KTp.mjs', 'dist/stale-lock-file-WwPWbFq9.mjs'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
function privateDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || path.resolve(input) !== input) throw fail('GROUP_LIVE_OPENCLAW_AUTH_SCOPE_INVALID');
  const s = fs.lstatSync(input);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o022 || fs.realpathSync(input) !== input) throw fail('GROUP_LIVE_OPENCLAW_AUTH_SCOPE_INVALID');
  return input;
}
function validateNativeFile(file,{optional=false}={}){
 let st;try{st=fs.lstatSync(file);}catch(e){if(optional&&e.code==='ENOENT')return null;throw fail('GROUP_LIVE_OPENCLAW_AUTH_NATIVE_FILE_INVALID');}
 if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.mode&0o022||fs.realpathSync(file)!==file)throw fail('GROUP_LIVE_OPENCLAW_AUTH_NATIVE_FILE_INVALID');
 return st;
}
function readNativeConfig(file){
 const before=validateNativeFile(file),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)throw fail('GROUP_LIVE_OPENCLAW_AUTH_NATIVE_FILE_CHANGED');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),entry=validateNativeFile(file);if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||entry.dev!==opened.dev||entry.ino!==opened.ino)throw fail('GROUP_LIVE_OPENCLAW_AUTH_NATIVE_FILE_CHANGED');return bytes;}finally{fs.closeSync(fd);}
}
// Pure projection of the pinned SDK gateway-state-owner/path helpers. This is
// lifecycle admission metadata, never an auth payload or a directory grant.
function ownerSidecarsForDatabases(databases){
 return databases.map(db=>{
  const dir=path.dirname(db),stateRoot=path.basename(dir)==='state'?path.dirname(dir):dir;
  return path.join(stateRoot,'tmp','openclaw-'+process.getuid(),'state.'+hash(db).slice(0,16)+'.lock');
 });
}
function selectStoredAuthority({ config, store, provider, model, resolveOrder, sdkFiles = [] }) {
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model.startsWith(provider + '/') || !config?.models?.providers?.[provider] || typeof resolveOrder !== 'function') throw fail('GROUP_LIVE_OPENCLAW_MODEL_UNCONFIRMED');
  const order = resolveOrder({ cfg: config, store, provider, includePendingOAuthRefresh: true, readinessMode: 'read-only' });
  if (!Array.isArray(order) || !order.length) throw fail('GROUP_LIVE_OPENCLAW_SELECTED_PROFILE_MISSING');
  const profileId = order[0], profile = store.profiles?.[profileId];
  if (!profile || profile.provider !== provider || profile.type !== 'api_key' || typeof profile.key !== 'string' || !profile.key.trim() || profile.keyRef || /\$\{|^\s*(?:env|file|exec):/u.test(profile.key)) throw fail('GROUP_LIVE_OPENCLAW_SELECTED_PROFILE_UNSUPPORTED');
  const metadata = config.auth?.profiles?.[profileId];
  if (metadata && (metadata.provider !== provider || metadata.mode !== 'api_key')) throw fail('GROUP_LIVE_OPENCLAW_SELECTED_PROFILE_UNSUPPORTED');
  let selectedKey = profile.key;
  const beforeProvider = config.models.providers[provider];
  const providerScopeDigest = hash(JSON.stringify({ baseUrl: beforeProvider.baseUrl ?? null, api: beforeProvider.api ?? null, authHeader: beforeProvider.authHeader ?? null, headers: beforeProvider.headers ?? null }));
  const evidence = Object.freeze({ method: 'installed-SDK-readOnly-runtime-store-and-readOnly-auth-order;only-selected-api-key-in-owned-provider-config', provider, model, profileIdDigest: hash(profileId), credentialType: 'api_key', orderedEligibleProfileCount: order.length, inlineCredentialDiffers: selectedKey !== beforeProvider.apiKey, originalStoreWritten: false, externalCliProfilesLoaded: false, modelOrAuthRefreshCalls: 0, credentialValuesExported: false, sdkFiles });
  const applyToProvider = target => {
    if (!selectedKey || !target || typeof target !== 'object') throw fail('GROUP_LIVE_OPENCLAW_SELECTED_AUTH_DISPOSED');
    const actual = hash(JSON.stringify({ baseUrl: target.baseUrl ?? null, api: target.api ?? null, authHeader: target.authHeader ?? null, headers: target.headers ?? null }));
    if (actual !== providerScopeDigest) throw fail('GROUP_LIVE_OPENCLAW_AUTH_TARGET_SCOPE_MISMATCH');
    target.apiKey = selectedKey;
    return evidence;
  };
  return Object.freeze({ evidence, applyToProvider, dispose: () => { selectedKey = null; } });
}
function selectExistingAuthority({ config, provider, model, nativeStateDir, homeDir, root, syntheticCanary = null, syntheticPrivateFile = null }) {
  const cp=require('node:child_process');
  const state=privateDirectory(nativeStateDir),home=privateDirectory(homeDir),owned=privateDirectory(root);
  if(!owned.startsWith('/private/tmp/sggroup-'))throw fail('GROUP_LIVE_OPENCLAW_AUTH_SCOPE_INVALID');
  privateDirectory(path.join(state,'agents/main/agent'));
  const scratch=fs.mkdtempSync(path.join(owned,'openclaw-auth-read-'));fs.chmodSync(scratch,0o700);
  const sdkFiles=modules.map(relative=>{const file=path.join(SDK,relative),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw fail('GROUP_LIVE_OPENCLAW_AUTH_SDK_MODULE_INVALID');return{relative,sha256:hash(fs.readFileSync(file)),bytes:s.size};});
  const configFile=path.join(state,'openclaw.json'),bytes=readNativeConfig(configFile),configSha256=hash(bytes);
  if(JSON.stringify(JSON.parse(bytes))!==JSON.stringify(config))throw fail('GROUP_LIVE_OPENCLAW_SOURCE_CONFIG_CHANGED');
  const node=process.env.SHOGGOTH_TEST_OPENCLAW_NODE||path.join(require('node:os').homedir(),'.local/share/node/v24.21.0/bin/node'),reader=path.join(__dirname,'group-collaboration-openclaw-auth-reader.cjs');
  const job={version:1,root:owned,scratch,configFile,configSha256,nativeStateDir:state,homeDir:home,provider,model,sdkFiles,syntheticCanary,syntheticPrivateFile};
  const jobFile=path.join(scratch,'job.json'),policyFile=path.join(scratch,'readonly.sb');
  fs.writeFileSync(jobFile,JSON.stringify(job),{flag:'wx',mode:0o400});
  const q=JSON.stringify;
  const publicRoots=['/System/Library','/usr/lib','/usr/share','/private/var/db/timezone',SDK];
  const originalDatabases=[path.join(state,'agents/main/agent/openclaw-agent.sqlite'),path.join(state,'state/openclaw.sqlite')];
  const originalAuthFiles=originalDatabases.flatMap(p=>[p,p+'-wal',p+'-shm']);
  const originalOwnerSidecars=ownerSidecarsForDatabases(originalDatabases);
  originalOwnerSidecars.forEach(file=>validateNativeFile(file,{optional:true}));
  originalAuthFiles.forEach(file=>validateNativeFile(file,{optional:true}));
  const dataFiles=[fs.realpathSync(node),fs.realpathSync(reader),fs.realpathSync(__filename),configFile,jobFile,policyFile,...originalAuthFiles,...originalOwnerSidecars,...(syntheticCanary?[syntheticCanary]:[])];
  const rules=['(version 1)','(deny default)','(import "dyld-support.sb")','(allow sysctl-read)','(allow file-read-metadata)',
    '(allow file-read-data '+publicRoots.map(p=>'(subpath '+q(p)+')').join(' ')+' '+dataFiles.map(p=>'(literal '+q(p)+')').join(' ')+' (subpath '+q(scratch)+'))',
    '(allow file-write* (subpath '+q(scratch)+'))','(allow process-exec (literal '+q(fs.realpathSync(node))+'))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))'];
  const policyText=rules.join('\n')+'\n';fs.writeFileSync(policyFile,policyText,{flag:'wx',mode:0o400});
  const readerBytes=fs.readFileSync(reader),helperBytes=fs.readFileSync(__filename),readerHash=hash(readerBytes),helperHash=hash(helperBytes);
  const ownedReader=path.join(scratch,'group-collaboration-openclaw-auth-reader.cjs'),ownedHelper=path.join(scratch,'group-collaboration-openclaw-auth.cjs');
  fs.writeFileSync(ownedReader,readerBytes,{flag:'wx',mode:0o400});fs.writeFileSync(ownedHelper,helperBytes,{flag:'wx',mode:0o400});fs.writeFileSync(path.join(scratch,'package.json'),JSON.stringify({private:true,type:'commonjs'}),{flag:'wx',mode:0o400});
  const child=cp.spawnSync('/usr/bin/sandbox-exec',['-f',policyFile,node,'--max-old-space-size=256',ownedReader,jobFile],{cwd:scratch,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:scratch,OPENCLAW_HOME:state,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:configFile,NODE_DISABLE_COMPILE_CACHE:'1',LANG:'C.UTF-8'},stdio:['ignore','ignore','pipe','pipe'],timeout:20000,maxBuffer:256*1024});
  const frame=child.output?.[3];let reply;try{reply=frame?JSON.parse(frame.toString('utf8')):null;}catch{}finally{frame?.fill(0);}
  if(child.error||child.signal||child.status!==0||reply?.status!=='passed'||reply.version!==1||reply.pid!==child.pid||typeof reply.key!=='string'){const e=fail(reply?.errorCode??'GROUP_LIVE_OPENCLAW_KERNEL_READONLY_AUTH_FAILED');e.kernelChild={pid:child.pid??null,exitCode:child.status,signal:child.signal,errorCode:child.error?.code??null,stderrDigest:hash(child.stderr??Buffer.alloc(0)),readerFailure:reply?.failure??null,stderrKinds:['sandbox_apply','dyld','Operation not permitted','Permission denied'].filter(v=>(child.stderr??Buffer.alloc(0)).toString('utf8').includes(v))};throw e;}
  if(readerHash!==hash(fs.readFileSync(ownedReader))||helperHash!==hash(fs.readFileSync(ownedHelper))||readerHash!==hash(fs.readFileSync(reader))||helperHash!==hash(fs.readFileSync(__filename))||configSha256!==hash(readNativeConfig(configFile))||sdkFiles.some(f=>hash(fs.readFileSync(path.join(SDK,f.relative)))!==f.sha256))throw fail('GROUP_LIVE_OPENCLAW_AUTH_SOURCE_CHANGED');
  if(reply.evidence?.provider!==provider||reply.evidence?.model!==model||JSON.stringify(reply.evidence?.sdkFiles)!==JSON.stringify(sdkFiles))throw fail('GROUP_LIVE_OPENCLAW_AUTH_READER_ATTESTATION_INVALID');
  let selectedKey=reply.key;reply.key=null;
  const scope=hash(JSON.stringify({baseUrl:config.models.providers[provider].baseUrl??null,api:config.models.providers[provider].api??null,authHeader:config.models.providers[provider].authHeader??null,headers:config.models.providers[provider].headers??null}));
  const apply=target=>{if(!selectedKey)throw fail('GROUP_LIVE_OPENCLAW_SELECTED_AUTH_DISPOSED');if(!target||hash(JSON.stringify({baseUrl:target.baseUrl??null,api:target.api??null,authHeader:target.authHeader??null,headers:target.headers??null}))!==scope)throw fail('GROUP_LIVE_OPENCLAW_AUTH_TARGET_SCOPE_MISMATCH');target.apiKey=selectedKey;};
  const evidence=Object.freeze({...reply.evidence,kernelReader:{method:'deny-default-seatbelt-original-auth-sqlite-read-only-no-original-write-no-network-no-fork-no-keychain;anonymous-FD3-only-selected-key',pid:child.pid,exitCode:child.status,sourceConfigSha256:configSha256,policyFile,policySha256:hash(policyText),readerSource:reader,readerSourceSha256:readerHash,ownedReaderSource:ownedReader,ownedHelperSource:ownedHelper,ownedCodeByteEquality:true,helperSourceSha256:helperHash,credentialChannel:'private-anonymous-FD3;no-stdout-stderr-env-file',sourceOriginalWriteAllowed:false,networkAllowed:false,keychainAllowed:false,forkAllowed:false,readCapabilitySummary:{authSqliteFiles:2,authWalShmExactLiterals:4,lifecycleOwnerSidecarExactLiterals:2,sourceDirectoryDataRead:false},canaryChecks:reply.canaryChecks}}); // gitleaks:allow -- Non-secret transport description
  return Object.freeze({evidence,applyToProvider:target=>{apply(target);return evidence;},dispose:()=>{selectedKey=null;}});
}
module.exports = { selectExistingAuthority, selectStoredAuthority };
