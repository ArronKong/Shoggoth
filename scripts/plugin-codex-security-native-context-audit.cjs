#!/usr/bin/env node
'use strict';
// Read-only native API audit. No original scanner, model turn, or credential is loaded.
// Usage: node script.cjs /absolute/codex [/absolute/result.json]
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
const {spawn,spawnSync}=require('node:child_process');
const binary=process.argv[2],outputPath=process.argv[3];
if(!path.isAbsolute(binary||''))throw Error('Provide the absolute fixed Codex binary path');
if(outputPath&&!path.isAbsolute(outputPath))throw Error('Output path must be absolute');
const root=fs.mkdtempSync('/private/tmp/shoggoth-codex-security-context-');
fs.chmodSync(root,0o700);
const home=path.join(root,'home'),cwd=path.join(root,'target');fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(cwd,{mode:0o700});
const mock=path.join(root,'metadata-mcp.cjs');
fs.writeFileSync(mock,`'use strict';
const readline=require('node:readline');
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
 if(r.method==='initialize')reply(r.id,{protocolVersion:r.params.protocolVersion,capabilities:{tools:{},experimental:{'codex/sandbox-state-meta':{}}},serverInfo:{name:'metadata-audit',version:'1'}});
 else if(r.method==='tools/list')reply(r.id,{tools:[{name:'inspect_request_context',description:'Return locally supplied metadata; no model or network.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]});
 else if(r.method==='tools/call')reply(r.id,{content:[{type:'text',text:'local context only'}],structuredContent:{metadata:r.params._meta||null}});
 else reply(r.id,{});
});`);
fs.writeFileSync(path.join(home,'config.toml'),`default_permissions = "audit_read_only"\n[permissions.audit_read_only]\nextends = ":read-only"\n[mcp_servers.metadata_audit]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mock)}]\nstartup_timeout_sec = 120\ntool_timeout_sec = 349200\n`);
const env={HOME:home,CODEX_HOME:home,XDG_CONFIG_HOME:home,XDG_CACHE_HOME:path.join(root,'cache'),PATH:'/usr/bin:/bin',TMPDIR:root};
const version=spawnSync(binary,['--version'],{cwd,env,encoding:'utf8',timeout:10000});
try{
 if(version.status!==0)throw Error('version failed: '+version.stderr);
 assert.equal(version.stdout.trim(),'codex-cli 0.159.2','This audit is pinned to 0.159.2');
}catch(error){fs.rmSync(root,{recursive:true,force:true});throw error}
const child=spawn(binary,['app-server','--stdio'],{cwd,env,stdio:['pipe','pipe','pipe']});
const pending=new Map();let next=1,stderr='',timer;
const lines=readline.createInterface({input:child.stdout});
lines.on('line',line=>{let r;try{r=JSON.parse(line)}catch{return}const p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Object.assign(Error(r.error.message),{rpcCode:r.error.code})):p.resolve(r.result)}});
child.stderr.on('data',c=>{stderr+=c.toString();if(stderr.length>10000)stderr=stderr.slice(-10000)});
function request(method,params){const id=next++;return new Promise((resolve,reject)=>{const t=setTimeout(()=>{pending.delete(id);reject(Error('timeout '+method))},20000);pending.set(id,{resolve,reject,timer:t});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})})+'\n')})}
(async()=>{try{
 const initialized=await request('initialize',{clientInfo:{name:'shoggoth_security_context_audit',version:'1'},capabilities:{experimentalApi:true}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}})+'\n');
 const account=await request('account/read',{refreshToken:false});
 assert.equal(account.account,null,'Credential-free audit must not have an authenticated account');
 const permissions=await request('permissionProfile/list',{cwd});
 assert.equal(permissions.data.find(p=>p.id==='audit_read_only')?.allowed,true);
 const config=await request('config/read',{cwd,includeLayers:false});
 const resolvedMcp=config.config?.mcp_servers?.metadata_audit;
 assert.equal(resolvedMcp?.startup_timeout_sec,120);
 assert.equal(resolvedMcp?.tool_timeout_sec,349200);
 const thread=await request('thread/start',{cwd,ephemeral:true});
 const statuses=await request('mcpServerStatus/list',{threadId:thread.thread.id,limit:100});
 const call=await request('mcpServer/tool/call',{threadId:thread.thread.id,server:'metadata_audit',tool:'inspect_request_context',arguments:{},_meta:{auditClientMarker:'local-only'}});
 const m=call.structuredContent?.metadata;
 assert.equal(thread.thread.ephemeral,true);
 assert.equal(thread.activePermissionProfile?.id,'audit_read_only');
 assert.equal(m?.threadId,thread.thread.id,'Native host must inject its real thread ID');
 assert.equal(m?.auditClientMarker,'local-only');
 assert.equal(Object.hasOwn(m,'codex/sandbox-state-meta'),false,'Pinned direct API does not inject sandbox metadata');
 assert.equal(Object.hasOwn(m,'x-codex-turn-metadata'),false);
 let unavailableServerRejected=false;
 try{await request('mcpServer/tool/call',{threadId:thread.thread.id,server:'absent_audit_server',tool:'inspect_request_context',arguments:{}})}catch(e){assert.ok(Number.isInteger(e.rpcCode));unavailableServerRejected=true}
 assert.equal(unavailableServerRejected,true,'An unavailable MCP must fail closed');
 assert.equal(fs.existsSync(path.join(home,'auth.json')),false);
 const output={schemaVersion:1,codexSourceCommit:'758ef40f50c1a458425c7cfbf1eb12cbc07af0b0',binaryPath:binary,binarySha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),version:version.stdout.trim(),isolatedHome:home,noCredentialsSupplied:true,noModelTurnStarted:true,noScanStarted:true,scannerLoaded:false,authenticatedAccount:false,inheritedEnvironmentKeys:[],originalTimeoutsAccepted:{startupSeconds:resolvedMcp.startup_timeout_sec,toolSeconds:resolvedMcp.tool_timeout_sec},unavailableServerRejected,permissionProfile:thread.activePermissionProfile||null,permissionCatalog:permissions,threadId:thread.thread.id,threadEphemeral:thread.thread.ephemeral,statuses,call};
 if(outputPath)fs.writeFileSync(outputPath,JSON.stringify(output,null,2)+'\n');
 console.log(JSON.stringify({outcome:'PASS',version:output.version,binarySha256:output.binarySha256,threadEphemeral:output.threadEphemeral,permissionProfile:output.permissionProfile,metadataKeys:m?Object.keys(m):[],threadIdMatches:m?.threadId===thread.thread.id,sandboxMetadata:m?.['codex/sandbox-state-meta']||null,noModelTurnStarted:true,noScanStarted:true,originalTimeoutsAccepted:true,unavailableServerRejected,scanAcceptance:false,resultPath:outputPath||null}));
 }catch(e){console.error(JSON.stringify({error:e.message,rpcCode:e.rpcCode,stderr}));process.exitCode=1}finally{child.stdin.end();lines.close();for(const p of pending.values())clearTimeout(p.timer);const killer=setTimeout(()=>child.kill('SIGTERM'),3000);child.once('close',()=>{clearTimeout(killer);fs.rmSync(root,{recursive:true,force:true})});}}
)();
