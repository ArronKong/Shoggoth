#!/usr/bin/env node
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {resolveServicePaths}=require("../app/agent-service/paths");
const {NativeMcpStore,quarantineNativeMcpRegistryForRestore}=require("../app/agent-service/native-mcp-store");
const {EncryptedSecretStore}=require("../app/agent-service/encrypted-secret-store");
const {McpConnectorSecrets}=require("../app/agent-service/mcp-connector-secrets");
const {McpPackageLauncher,validatePackageTransport,tokenizeCommand}=require("../app/agent-service/mcp-package-launcher");
const {McpRegistryClient,parseRegistryEntry,resolveOption}=require("../app/agent-service/mcp-registry-client");
const {validateConnectorParams,validateConnectorResult}=require("../app/core/connector-dto");
const temp=t=>{const root=fs.mkdtempSync('/private/tmp/shoggoth-mcp-foundation-');fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,'state'),profileRoot:path.join(root,'profile'),cacheRoot:path.join(root,'cache')});fs.mkdirSync(paths.defaultWorkspaceDir,{recursive:true,mode:0o700});return {root,paths};};
const server=(overrides={})=>({id:'fixture',name:'Fixture',enabled:true,source:{kind:'custom'},transport:{kind:'remote',protocol:'streamable-http',url:'https://mcp.example.test/mcp'},auth:{kind:'none'},secretRef:null,setup:{requiredFields:[],configuredFields:[]},status:'checking',lastCheck:null,disabledProfileIds:[],...overrides});
const entry=(overrides={})=>({server:{name:'io.example/fixture',version:'1.2.3',description:'untrusted description',packages:[{registryType:'npm',identifier:'@example/server',version:'1.2.3',transport:{type:'stdio'},packageArguments:[{type:'positional',valueHint:'target_dir',isRequired:true}],environmentVariables:[{name:'API_KEY',isSecret:true,isRequired:true}]}],remotes:[{type:'streamable-http',url:'https://example.test/mcp',headers:[{name:'Authorization',isSecret:true,isRequired:true}]}],...overrides},_meta:{'io.modelcontextprotocol.registry/official':{status:'active',isLatest:true}}});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
test('schema1 migration keeps all command bytes private, preserves default all/new Agent and uses CAS',t=>{
 const {paths}=temp(t);fs.mkdirSync(paths.nativeMcpDir,{recursive:true,mode:0o700});const old={schemaVersion:1,revision:8,updatedAt:10,servers:[{id:'old',name:'Old',command:'/missing/tool',args:['secret-canary'],cwd:'/missing/workspace',enabled:false,createdAt:5,updatedAt:10}]};
 fs.writeFileSync(paths.nativeMcpRegistryPath,JSON.stringify(old),{mode:0o600});const store=new NativeMcpStore({paths,now:()=>20}).open();t.after(()=>store.close());
 assert.equal(store.revision,9);assert.equal(store.getPrivate('old').transport.args[0],'secret-canary');assert.deepEqual(store.get('old').disabledProfileIds,[]);assert.ok(!JSON.stringify(store.list()).includes('secret-canary'));
 assert.equal(JSON.parse(fs.readFileSync(paths.nativeMcpRegistryPath)).schemaVersion,2);assert.throws(()=>store.remove({id:'old',expectedRevision:8}),{code:'MCP_REGISTRY_REVISION_CONFLICT'});
 store.add({server:server({status:'ready'}),expectedRevision:store.revision});assert.equal(store.isAvailable('fixture','new-profile-created-later'),true);store.update({id:'fixture',patch:{disabledProfileIds:['one-agent']},expectedRevision:store.revision});assert.equal(store.isAvailable('fixture','one-agent'),false);assert.equal(store.isAvailable('fixture','another-new-agent'),true);
});
test('corrupt registry fails closed without rewriting bytes',t=>{const {paths}=temp(t);fs.mkdirSync(paths.nativeMcpDir,{recursive:true,mode:0o700});const raw='{"schemaVersion":2,"revision":1,"servers":[]}';fs.writeFileSync(paths.nativeMcpRegistryPath,raw,{mode:0o600});assert.throws(()=>new NativeMcpStore({paths}).open(),{code:'MCP_REGISTRY_CORRUPT'});assert.equal(fs.readFileSync(paths.nativeMcpRegistryPath,'utf8'),raw);});
test('schema2 restore disables remote and package entries and drops credential references',t=>{const {paths}=temp(t);const store=new NativeMcpStore({paths}).open();store.add({server:server({status:'ready',secretRef:'mcp-connector:fixture'}),expectedRevision:store.revision});store.close();assert.deepEqual(quarantineNativeMcpRegistryForRestore({paths}),{disabled:1,retained:1});store.open();t.after(()=>store.close());const privateRecord=store.getPrivate('fixture');assert.equal(privateRecord.status,'disabled');assert.equal(privateRecord.secretRef,null);assert.equal(privateRecord.enabled,false);assert.equal(store.isAvailable('fixture','later'),false);});
test('public contract rejects args, secretRef, extra keys and hostile getters',t=>{const {paths}=temp(t),store=new NativeMcpStore({paths}).open();t.after(()=>store.close());store.add({server:server(),expectedRevision:1});assert.deepEqual(validateConnectorResult('connector.mcp.list',store.list()),store.list());const leaked=store.list();leaked.servers[0].secretRef='canary';assert.throws(()=>validateConnectorResult('connector.mcp.list',leaked));assert.throws(()=>validateConnectorParams('connector.mcp.verify',{id:'fixture',secret:'canary'}));let called=false;const hostile={};Object.defineProperty(hostile,'id',{enumerable:true,get(){called=true;return 'fixture';}});assert.throws(()=>validateConnectorParams('connector.mcp.verify',hostile));assert.equal(called,false);});
test('Blender presentation identity survives storage without exposing argv or trusting its display name',t=>{
 const {root,paths}=temp(t),store=new NativeMcpStore({paths}).open();t.after(()=>store.close());
 const command=path.join(root,'python3');fs.symlinkSync(process.execPath,command);
 const transport={kind:'stdio-command',command,args:['-m','blmcp'],cwd:paths.defaultWorkspaceDir};
 store.add({server:server({transport}),expectedRevision:store.revision});
 store.close();store.open();
 const saved=store.get('fixture');assert.equal(saved.recommendationId,'blender-lab');
 assert.deepEqual(saved.transport,{kind:'stdio-command',command});
 assert.equal(store.getPrivate('fixture').recommendationId,undefined,'identity is derived, not a second persisted authority');
 assert.deepEqual(validateConnectorResult('connector.mcp.list',store.list()),store.list());
 for(const recommendationId of ['unknown','secret-canary',null])assert.throws(()=>validateConnectorResult('connector.mcp.list',{...store.list(),servers:[{...saved,recommendationId}]}));
 assert.throws(()=>validateConnectorResult('connector.mcp.list',{...store.list(),servers:[{...saved,transport:{kind:'remote',protocol:'streamable-http',url:'https://example.test'}}]}));
 assert.throws(()=>validateConnectorParams('connector.mcp.add',{source:{kind:'custom'},option:transport,expectedRevision:store.revision,recommendationId:'blender-lab'}));
 for(const args of [['-m','other'],['-m','blmcp','secret-canary']]){
  store.update({id:'fixture',patch:{name:'Blender Lab',transport:{...transport,args}},expectedRevision:store.revision});
  assert.equal(store.get('fixture').recommendationId,undefined);assert.ok(!JSON.stringify(store.list()).includes('secret-canary'));
 }
 const nodeCommand=path.join(root,'node');fs.symlinkSync(process.execPath,nodeCommand);
 store.update({id:'fixture',patch:{transport:{...transport,command:nodeCommand,args:['-m','blmcp']}},expectedRevision:store.revision});
 assert.equal(store.get('fixture').recommendationId,undefined);
});
test('encrypted secrets survive restart; disk and DTO never contain plaintext; missing key fails closed',async t=>{const {paths}=temp(t),key=crypto.randomBytes(32);let available=true;const broker={async encrypt(p){if(!available)throw Error();const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.getAuthTag?.()||Buffer.alloc(0)]);}};
 broker.encrypt=async p=>{if(!available)throw Error();const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(p),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]);};broker.decrypt=async p=>{if(!available)throw Error();const d=crypto.createDecipheriv('aes-256-gcm',key,p.subarray(0,12));d.setAuthTag(p.subarray(12,28));return Buffer.concat([d.update(p.subarray(28)),d.final()]);};
 let encrypted=await new EncryptedSecretStore({paths,cryptoBroker:broker}).open();let secrets=new McpConnectorSecrets({secretStore:encrypted});await secrets.write('fixture',{env:{API_KEY:'mcp-secret-canary'},headers:{Authorization:'Bearer token-canary'}});assert.ok(!fs.readFileSync(paths.encryptedSecretsPath,'utf8').includes('canary'));await encrypted.close();encrypted=await new EncryptedSecretStore({paths,cryptoBroker:broker}).open();secrets=new McpConnectorSecrets({secretStore:encrypted});assert.equal((await secrets.read('fixture')).env.API_KEY,'mcp-secret-canary');await encrypted.close();available=false;encrypted=await new EncryptedSecretStore({paths,cryptoBroker:broker}).open();t.after(()=>encrypted.close());secrets=new McpConnectorSecrets({secretStore:encrypted});await assert.rejects(secrets.read('fixture'),{code:'MCP_CREDENTIALS_LOCKED'});await assert.rejects(secrets.write('other',{env:{API_KEY:'another'}}),{code:'MCP_CREDENTIALS_LOCKED'});
});
test('concurrent secret patches preserve OAuth and headers without exposing secrets as argv',async()=>{const data=new Map(),secretStore={async get(k){return data.get(k)||null;},async put(k,v){data.set(k,v);},async delete(k){return data.delete(k);}};const s=new McpConnectorSecrets({secretStore});await Promise.all([s.write('fixture',{env:{API_KEY:'abc'}}),s.write('fixture',{oauthToken:{access_token:'token'}})]);assert.deepEqual(await s.read('fixture'),{env:{API_KEY:'abc'},oauthToken:{access_token:'token'}});await assert.rejects(s.write('fixture',{headers:{Authorization:'x\r\nInjected: yes'}}),{code:'MCP_SECRET_INVALID'});await assert.rejects(s.write('fixture',{env:{NODE_OPTIONS:'--import evil'}}),{code:'MCP_SECRET_INVALID'});});
test('package argv pins supported registries and rejects ranges, tags, URL packages and injected names',async()=>{const launcher=new McpPackageLauncher({resolveRuntime:n=>`/runtime/${n}`});assert.deepEqual((await launcher.prepare({kind:'stdio-package',registryType:'npm',identifier:'@mcp/server',version:'1.2.3',packageArgs:['/tmp']})).args,['--yes','@mcp/server@1.2.3','/tmp']);assert.deepEqual((await launcher.prepare({kind:'stdio-package',registryType:'pypi',identifier:'server-mcp',version:'1.2.3',packageArgs:[]})).args,['server-mcp==1.2.3']);const docker=await launcher.prepare({kind:'stdio-package',registryType:'oci',identifier:'ghcr.io/example/mcp:1.2.3',version:'1.2.3',packageArgs:[]},{env:{API_KEY:'secret-canary'}});assert.deepEqual(docker.args,['run','-i','--rm','--env','API_KEY','ghcr.io/example/mcp:1.2.3']);for(const version of ['latest','^1.2.3','1.2.3;echo x','*'])assert.throws(()=>validatePackageTransport({kind:'stdio-package',registryType:'npm',identifier:'x',version,packageArgs:[]}));assert.throws(()=>validatePackageTransport({kind:'stdio-package',registryType:'npm',identifier:'https://evil.test/install',version:'1.2.3',packageArgs:[]}));assert.throws(()=>validatePackageTransport({kind:'stdio-package',registryType:'oci',identifier:'ghcr.io/example/mcp:latest',version:'latest',packageArgs:[]}));});
test('custom command parsing preserves quoted args without shell expansion and rejects expressions',()=>{assert.deepEqual(tokenizeCommand('/safe/bin/mcp "a b" \'single\' empty\\ arg ""'),['/safe/bin/mcp','a b','single','empty arg','']);for(const input of ['x && y','x | y','x; y','x $(evil)','x > file','x "unterminated'])assert.throws(()=>tokenizeCommand(input));});
test('registry accepts only latest active, rejects malicious package metadata, resolves fields without secret argv',()=>{const valid=entry(),item=parseRegistryEntry(valid);assert.equal(item.options.length,2);const resolved=resolveOption(item,'package:0',{arguments:{target_dir:'/workspace'},env:{API_KEY:'secret-canary'}});assert.deepEqual(resolved.transport.packageArgs,['/workspace']);assert.equal(resolved.env.API_KEY,'secret-canary');assert.ok(!JSON.stringify(resolved.transport).includes('secret-canary'));const inactive=entry();inactive._meta['io.modelcontextprotocol.registry/official'].status='deleted';assert.equal(parseRegistryEntry(inactive),null);assert.equal(parseRegistryEntry(entry({packages:[{registryType:'npm',identifier:'evil;curl',version:'latest',transport:{type:'stdio'}}]})).options.length,1);const secretArg=entry({remotes:[],packages:[{registryType:'npm',identifier:'ok',version:'1.2.3',transport:{type:'stdio'},packageArguments:[{type:'positional',isSecret:true,value:'secret'}]}]});assert.equal(parseRegistryEntry(secretArg).options.length,0);assert.throws(()=>resolveOption(item,'package:0',{}),{code:'MCP_SETUP_REQUIRED'});});
test('registry retains bounded standard icon metadata without fetching image URLs',async()=>{
 const icons=[{src:'https://cdn.example.test/mark-light.svg',mimeType:'image/svg+xml',sizes:['any'],theme:'light',ignoredPublisherField:'not-public'},
  {src:'https://cdn.example.test/mark-dark.png',mimeType:'image/png',sizes:['48x48','256x256'],theme:'dark'},
  {src:'https://cdn.example.test/jpeg',mimeType:'image/jpeg'},{src:'https://cdn.example.test/jpg',mimeType:'image/jpg'},
  {src:'https://cdn.example.test/webp',mimeType:'image/webp'},{src:'https://cdn.example.test/inferred'}];
 let calls=0;const client=new McpRegistryClient({packageLauncher:{async prepare(){}},fetch:async url=>{calls++;assert.match(url,/^https:\/\/registry\.modelcontextprotocol\.io\/v0\.1\/servers\?/u);return response({servers:[entry({icons})],metadata:{}});}});
 const page=await client.list({search:'fixture'});assert.equal(calls,1,'metadata read must not fetch image URLs');
 const expected=icons.map(({ignoredPublisherField,...icon})=>icon);assert.deepEqual(page.items[0].icons,expected);assert.deepEqual(validateConnectorResult('connector.mcp.registry.list',page),page);
 const withoutIcons=structuredClone(page);delete withoutIcons.items[0].icons;assert.deepEqual(validateConnectorResult('connector.mcp.registry.list',withoutIcons),withoutIcons,'older optional metadata is still accepted');
});
test('malformed registry icons are ignored per icon while public icon DTO rejects unsafe metadata',async()=>{
 const invalidIcons=[null,{}, {src:'javascript:alert(1)'},{src:'data:image/png;base64,AAAA'},{src:'http://127.0.0.1/icon.png'},
  {src:'https://user:secret@example.test/icon.png'},{src:'https://example.test/icon.png\n'},
  {src:'https://example.test/'+ 'a'.repeat(2048)}, {src:'https://example.test/icon.avif',mimeType:'image/avif'},
  {src:'https://example.test/icon',mimeType:'text/html'},{src:'https://example.test/icon',sizes:['48 X 48']},
  {src:'https://example.test/icon',sizes:['0x32']},{src:'https://example.test/icon',sizes:['123456x32']},
  {src:'https://example.test/icon',sizes:Array(17).fill('32x32')},{src:'https://example.test/icon',theme:'auto'},
  {src:'https://example.test/icon',sizes:'32x32'}];
 const valid={src:'https://example.test/icon.png',mimeType:'image/png',sizes:['32x32']};
 for(const bad of invalidIcons){
  const parsed=parseRegistryEntry(entry({icons:[bad,valid]}));assert.equal(parsed.registryName,'io.example/fixture');assert.equal(parsed.options.length,2);assert.deepEqual(parsed.icons,[valid]);
 }
 for(const malformed of [null,{},'https://example.test/icon.png']){const parsed=parseRegistryEntry(entry({icons:malformed}));assert.equal(parsed.options.length,2);assert.equal(parsed.icons,undefined);}
 const bounded=parseRegistryEntry(entry({icons:Array(20).fill(valid)}));assert.equal(bounded.icons.length,16);
 const client=new McpRegistryClient({packageLauncher:{async prepare(){}},fetch:async()=>response({servers:[entry({icons:[valid]})],metadata:{}})});
 const page=await client.list();
 for(const bad of invalidIcons){const unsafe=structuredClone(page);unsafe.items[0].icons=[bad];assert.throws(()=>validateConnectorResult('connector.mcp.registry.list',unsafe));}
 for(const icons of [null,{},Array(17).fill(valid),[{...valid,unexpected:'must-not-cross'}]]){const unsafe=structuredClone(page);unsafe.items[0].icons=icons;assert.throws(()=>validateConnectorResult('connector.mcp.registry.list',unsafe));}
});
test('registry paging caches safely, encodes cursors and terminates cycles; malformed entries do not poison installed state',async()=>{let calls=0;const first=entry();const client=new McpRegistryClient({fetch:async url=>{calls++;assert.ok(url.includes('/v0.1/servers?'));return response({servers:[first,{bad:true}],metadata:{nextCursor:'cursor&not=query'}});}});const firstPage=await client.list({search:'test'});assert.equal(firstPage.items.length,1);assert.deepEqual(await client.list({search:'test'}),firstPage);assert.equal(calls,1);await assert.rejects(client.list({search:'test',cursor:'cursor&not=query'}),{code:'MCP_REGISTRY_CURSOR_INVALID'});const malformed=new McpRegistryClient({fetch:async()=>response({servers:'bad',metadata:{}})});await assert.rejects(malformed.list(),{code:'MCP_REGISTRY_RESPONSE_INVALID'});});
test('one missing trusted command only fails its own record; status CAS and unrelated connectors remain usable',t=>{
 const {root,paths}=temp(t),command=path.join(root,'mcp-command');fs.writeFileSync(command,'#!/usr/bin/env node\n',{mode:0o700});const store=new NativeMcpStore({paths}).open();t.after(()=>store.close());
 store.add({server:server({id:'local',transport:{kind:'stdio-command',command,args:[],cwd:root},status:'ready'}),expectedRevision:store.revision});store.add({server:server({status:'ready'}),expectedRevision:store.revision});fs.unlinkSync(command);
 store.setStatus('local','failed',{at:Date.now(),toolCount:0,errorCode:'MCP_SERVER_PATH_INVALID'});assert.equal(store.get('local').status,'failed');assert.equal(store.isAvailable('fixture','new-agent'),true);
 store.close();store.open();assert.equal(store.get('local').status,'failed');assert.equal(store.isAvailable('fixture','new-agent'),true);assert.throws(()=>store.prepareLaunch(store.getPrivate('local')),{code:'MCP_SERVER_PATH_INVALID'});
 assert.throws(()=>store.add({server:server({id:'outside',transport:{kind:'stdio-command',command:'/bin/sh',args:[],cwd:root}}),expectedRevision:store.revision}),{code:'MCP_SERVER_PATH_INVALID'});
});
test('registry reports absent package runtimes without launching anything',async()=>{
 const client=new McpRegistryClient({packageLauncher:{async prepare(){throw Error('missing');}},fetch:async()=>response({servers:[entry()],metadata:{}})});
 const page=await client.list({search:'fixture'});assert.equal(page.items[0].options.find(o=>o.id==='package:0').available,false);assert.equal(page.items[0].options.find(o=>o.id==='package:0').errorCode,'MCP_PACKAGE_RUNTIME_MISSING');assert.equal(page.items[0].options.find(o=>o.id==='remote:0').available,true);validateConnectorResult('connector.mcp.registry.list',page);
});
test('global secret matcher recognizes only sensitive MCP envelope leaves and forgets rotated/deleted/closed values',async t=>{
 const {paths}=temp(t);const broker={encrypt:async b=>Buffer.from(b).reverse(),decrypt:async b=>Buffer.from(b).reverse()};const encrypted=await new EncryptedSecretStore({paths,cryptoBroker:broker}).open();t.after(()=>encrypted.close());const s=new McpConnectorSecrets({secretStore:encrypted});
 const envelope={env:{API_KEY:'mcp-env-canary-1'},headers:{Authorization:'Bearer mcp-header-canary-1','X-Basic-Authorization':'Basic '+Buffer.from('mcp-basic-user-1:mcp-basic-pass-1').toString('base64')},oauthToken:{access_token:'mcp-access-canary-1',refresh_token:'mcp-refresh-canary-1',id_token:'mcp-identity-canary-1',scope:'public-scope'},oauthClient:{clientId:'public-client-id',client_secret:'mcp-client-canary-1',redirectUri:'http://127.0.0.1:18873/mcp/oauth/callback'},oauthDiscovery:{issuer:'https://public-issuer.example.test'}};
 await s.write('fixture',envelope);for(const canary of ['mcp-env-canary-1','Bearer mcp-header-canary-1','mcp-header-canary-1',Buffer.from('mcp-basic-user-1:mcp-basic-pass-1').toString('base64'),'mcp-basic-user-1:mcp-basic-pass-1','mcp-basic-pass-1','mcp-access-canary-1','mcp-refresh-canary-1','mcp-identity-canary-1','mcp-client-canary-1'])assert.equal(encrypted.matchesPlaintext('before '+canary+' after'),true,canary);
 for(const publicValue of ['public-client-id','public-scope','mcp-basic-user-1','https://public-issuer.example.test','http://127.0.0.1:18873/mcp/oauth/callback'])assert.equal(encrypted.matchesPlaintext(publicValue),false,publicValue);
 assert.equal(encrypted.matchesPlaintext(JSON.stringify(envelope)),true,'complete encrypted plaintext remains matched');
 await s.write('fixture',{env:{API_KEY:'mcp-env-canary-2'},headers:{Authorization:'Bearer mcp-header-canary-2','X-Basic-Authorization':'Basic '+Buffer.from('mcp-basic-user-2:mcp-basic-pass-2').toString('base64')},oauthToken:{access_token:'mcp-access-canary-2',id_token:'mcp-identity-canary-2'},oauthClient:{clientSecret:'mcp-client-canary-2'}});
 for(const old of ['mcp-env-canary-1','mcp-header-canary-1','mcp-basic-user-1','mcp-basic-pass-1','mcp-access-canary-1','mcp-refresh-canary-1','mcp-identity-canary-1','mcp-client-canary-1'])assert.equal(encrypted.matchesPlaintext(old),false,old);
 for(const fresh of ['mcp-env-canary-2','mcp-header-canary-2','mcp-basic-pass-2','mcp-access-canary-2','mcp-identity-canary-2','mcp-client-canary-2'])assert.equal(encrypted.matchesPlaintext(fresh),true,fresh);
 let captured;encrypted.withPlaintextMatcher(m=>{captured=m;assert.equal(m('mcp-env-canary-2'),true);});assert.throws(()=>captured('mcp-env-canary-2'),{code:'SECRET_MATCHER_CLOSED'});
 await s.remove('fixture');for(const value of ['mcp-env-canary-2','mcp-header-canary-2','mcp-basic-user-2','mcp-basic-pass-2','mcp-identity-canary-2'])assert.equal(encrypted.matchesPlaintext(value),false);await encrypted.close();assert.throws(()=>encrypted.matchesPlaintext('mcp-env-canary-2'),{code:'SECRET_STORE_CLOSED'});
});
test('restart resolves an interrupted checking state while cached readiness remains per-connector',t=>{
 const {paths}=temp(t),store=new NativeMcpStore({paths,now:()=>123}).open();t.after(()=>store.close());store.add({server:server(),expectedRevision:store.revision});store.add({server:server({id:'cached-ready',status:'ready'}),expectedRevision:store.revision});store.close();store.open();assert.equal(store.get('fixture').status,'failed');assert.equal(store.get('fixture').lastCheck.errorCode,'MCP_CHECK_INTERRUPTED');assert.equal(store.get('cached-ready').status,'ready');assert.equal(store.isAvailable('fixture','new-agent'),false);assert.equal(store.isAvailable('cached-ready','new-agent'),true);
});
test('OAuth public DTO is exact, exposes stable callback information and rejects credential-bearing extra metadata',()=>{
 assert.deepEqual(validateConnectorParams('connector.mcp.oauth.info',{}),{});assert.deepEqual(validateConnectorResult('connector.mcp.oauth.info',{redirectUri:'http://127.0.0.1:18873/mcp/oauth/callback'}),{redirectUri:'http://127.0.0.1:18873/mcp/oauth/callback'});
 const result={id:'fixture',signInId:'sign-in-fixture',status:'pending',authorizationUrl:'https://auth.example.test/authorize?client_id=public',redirectUri:'http://127.0.0.1:18873/mcp/oauth/callback',expiresAt:123,errorCode:null,flow:'redirect',userCode:null,installationUrl:null};assert.deepEqual(validateConnectorResult('connector.mcp.signin.start',result),result);assert.throws(()=>validateConnectorResult('connector.mcp.signin.start',{...result,oauthToken:{access_token:'secret-canary'}}));assert.throws(()=>validateConnectorResult('connector.mcp.signin.start',{...result,errorCode:{token:'secret-canary'}}));assert.throws(()=>validateConnectorResult('connector.mcp.oauth.info',{redirectUri:'javascript:alert(1)'}));
});

 test('OCI digest pins are preserved literally and floating tags still fail closed',async()=>{
 const launcher=new McpPackageLauncher({resolveRuntime:()=>'/runtime/docker'}),identifier='ghcr.io/example/mcp@sha256:'+'a'.repeat(64);
 const transport={kind:'stdio-package',registryType:'oci',identifier,version:'1.2.3',packageArgs:['--readonly']};
 assert.equal(validatePackageTransport(transport).identifier,identifier);
 assert.deepEqual((await launcher.prepare(transport)).args,['run','-i','--rm',identifier,'--readonly']);
 for(const identifier of ['ghcr.io/example/mcp:latest','ghcr.io/example/mcp:stable','ghcr.io/example/mcp@sha256:'+'b'.repeat(63)])assert.throws(()=>validatePackageTransport({...transport,identifier,version:'latest'}),{code:'MCP_PACKAGE_VERSION_INVALID'});
 assert.throws(()=>validatePackageTransport({...transport,identifier:'ghcr.io/example/mcp',version:'latest'}),{code:'MCP_PACKAGE_VERSION_INVALID'});
 });

test('connection acknowledgement error survives product and IPC boundaries without exposing internal messages',()=>{
 const {connectorPublicError,CONNECTOR_PUBLIC_MESSAGES}=require('../app/core/connector-errors');
 const {mapChatServiceError}=require('../app/agent-service/chat-service-protocol');
 const {PUBLIC_MESSAGES}=require('../app/agent-service/mcp-product-tool-controller');
 for(const code of ['MCP_REQUEST_ACK_UNKNOWN','MCP_CONNECTION_HOST_UNAVAILABLE','MCP_CONNECTION_OWNER_UNCONFIRMED','MCP_CONNECTION_ACK_UNKNOWN','MCP_CONNECTION_ACK_CAPACITY']){
  const internal={code,message:'credential-canary-must-not-cross'};
  for(const result of [connectorPublicError(internal),mapChatServiceError(internal)]){
   assert.equal(result.code,code);assert.equal(result.message,CONNECTOR_PUBLIC_MESSAGES[code]);assert.ok(!JSON.stringify(result).includes('credential-canary'));
  }
  assert.equal(PUBLIC_MESSAGES[code],CONNECTOR_PUBLIC_MESSAGES[code]);
 }
 assert.match(CONNECTOR_PUBLIC_MESSAGES.MCP_REQUEST_ACK_UNKNOWN,/不会重复发送/);
});
