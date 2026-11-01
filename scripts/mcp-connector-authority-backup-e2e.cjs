#!/usr/bin/env node
"use strict";
// Real schema-2 Store -> authority backup/verify/restore -> encrypted vault ->
// Controller replacement -> Manager -> actual HTTP MCP. No network registry,
// installed Host, personal vault or user state is used.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),http=require("node:http");
const {resolveServicePaths}=require("../app/agent-service/paths");
const {createAuthorityBackup,verifyAuthorityBackup,restoreAuthorityBackup}=require("../app/agent-service/authority-backup");
const {NativeMcpStore}=require("../app/agent-service/native-mcp-store");
const {EncryptedSecretStore}=require("../app/agent-service/encrypted-secret-store");
const {McpConnectorSecrets}=require("../app/agent-service/mcp-connector-secrets");
const {McpConnectorController}=require("../app/agent-service/mcp-connector-controller");
const {NativeMcpClientManager}=require("../app/agent-service/native-mcp-client-manager");
const {McpOAuthClient}=require("../app/agent-service/mcp-oauth-client");
const {startFixture,CANARY}=require("./fixtures/mcp-connector-http-fixture.cjs");
async function port(){const server=http.createServer();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
function broker(){const key=crypto.randomBytes(32);return{async encrypt(raw){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv),data=Buffer.concat([cipher.update(raw),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]);},async decrypt(raw){const decipher=crypto.createDecipheriv("aes-256-gcm",key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]);}};}

test("mixed schema-2 authority backup restores all six transports inert and first replacement cannot resurrect copied vault credentials",async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"mcp-bak-e2e-")));fs.chmodSync(root,0o700);
 const pathsFor=stateRoot=>resolveServicePaths({trustedRoot:root,stateRoot,profileRoot:path.join(root,"profiles"),cacheRoot:path.join(root,"cache")});
 const paths=pathsFor(path.join(root,"source")),cryptoBroker=broker(),fixture=await startFixture();let store,vault,restoredStore,restoredVault,manager,oauth,controller;
 try{
  store=new NativeMcpStore({paths}).open();vault=await new EncryptedSecretStore({paths,cryptoBroker}).open();const secrets=new McpConnectorSecrets({secretStore:vault});
  const command=path.join(root,"custom-mcp");fs.writeFileSync(command,"#!/bin/sh\nexit 0\n",{mode:0o700});
  const transports=[
   ["npm",{kind:"stdio-package",registryType:"npm",identifier:"@modelcontextprotocol/server-filesystem",version:"2025.8.21",packageArgs:[root]},"none"],
   ["pypi",{kind:"stdio-package",registryType:"pypi",identifier:"mcp-server-time",version:"2025.8.4",packageArgs:[]},"none"],
   ["oci",{kind:"stdio-package",registryType:"oci",identifier:"example.invalid/shoggoth-fixture@sha256:"+"a".repeat(64),version:"1.0.0",packageArgs:[]},"none"],
   ["command",{kind:"stdio-command",command,args:["--readonly"],cwd:root},"none"],
   ["remote",{kind:"remote",protocol:"streamable-http",url:fixture.origin+"/public"},"headers"],
   ["oauth",{kind:"remote",protocol:"streamable-http",url:fixture.origin+"/mcp"},"oauth-client"],
  ];
  const stale={env:{LEGACY_TOKEN:CANARY},headers:{"X-Legacy-Token":CANARY},oauthClient:{client_id:"old-client",client_secret:CANARY},oauthToken:{access_token:CANARY,refresh_token:CANARY,token_type:"Bearer"},oauthDiscovery:{issuer:fixture.origin},oauthCodeVerifier:CANARY};
  for(const[id,transport,auth]of transports){const secretRef=await secrets.set(id,stale);store.add({expectedRevision:store.revision,server:{id,name:"backup "+id,enabled:true,source:{kind:"custom"},transport,auth:{kind:auth},secretRef,setup:{requiredFields:auth==="oauth-client"?["oauthClient:clientId"]:["env:LEGACY_TOKEN"],configuredFields:["env:LEGACY_TOKEN","header:X-Legacy-Token","oauthClient:clientId"]},status:"ready",lastCheck:{at:Date.now(),toolCount:1,errorCode:null},disabledProfileIds:["native-excluded","mcp-openclaw-excluded"]}});}
  const sourceRecords=new Map(transports.map(([id])=>[id,store.getPrivate(id)])),sourceRegistry=fs.readFileSync(paths.nativeMcpRegistryPath),sourceVault=fs.readFileSync(paths.encryptedSecretsPath);
  assert.equal(sourceVault.includes(CANARY),false);store.close();await vault.close();
  const backup=createAuthorityBackup({paths,backupId:"mixed-schema2"}),verified=verifyAuthorityBackup({paths,backupId:"mixed-schema2"});
  assert.equal(verified.manifest.rootDigest,backup.manifest.rootDigest);assert.ok(verified.manifest.entries.some(entry=>entry.path==="mcp-servers/registry.json"));assert.ok(verified.manifest.entries.some(entry=>entry.path==="encrypted-secrets.json"),"real backup copies the encrypted orphan envelope, so reset refs are essential");
  const destination=path.join(root,"restored"),restoration=restoreAuthorityBackup({paths,backupId:"mixed-schema2",destinationStateDir:destination});assert.deepEqual(restoration.nativeMcpRestore,{disabled:6,retained:6});
  assert.deepEqual(fs.readFileSync(paths.nativeMcpRegistryPath),sourceRegistry);assert.deepEqual(fs.readFileSync(paths.encryptedSecretsPath),sourceVault);
  const restoredPaths=pathsFor(destination);restoredStore=new NativeMcpStore({paths:restoredPaths}).open();restoredVault=await new EncryptedSecretStore({paths:restoredPaths,cryptoBroker}).open();const restoredSecrets=new McpConnectorSecrets({secretStore:restoredVault});
  for(const[id]of transports){const old=sourceRecords.get(id),current=restoredStore.getPrivate(id);assert.deepEqual(current.transport,old.transport);assert.deepEqual(current.disabledProfileIds,old.disabledProfileIds);assert.deepEqual(current.setup.requiredFields,old.setup.requiredFields);assert.equal(current.enabled,false);assert.equal(current.status,"disabled");assert.equal(current.secretRef,null);assert.deepEqual(current.setup.configuredFields,[]);assert.equal(current.lastCheck,null);assert.equal(restoredStore.isAvailable(id,"new-agent"),false);assert.deepEqual(await restoredSecrets.read(id),stale,"encrypted old credentials really exist, but are no longer authority");}
  const sent=[];manager=new NativeMcpClientManager({store:restoredStore,secrets:restoredSecrets,fetch:(url,init)=>{sent.push(Object.fromEntries(new Headers(init.headers)));return fetch(url,init);}});oauth=new McpOAuthClient({store:restoredStore,secrets:restoredSecrets,callbackPort:await port()});manager.setOAuth(oauth);controller=new McpConnectorController({store:restoredStore,secrets:restoredSecrets,manager,oauth,paths:restoredPaths}).open();
  await assert.rejects(manager.listTools("remote"),{code:"MCP_SERVER_NOT_FOUND"});assert.equal(sent.length,0);
  const remote=await controller.handle("connector.mcp.rebind",{id:"remote",option:sourceRecords.get("remote").transport,expectedRevision:restoredStore.revision});assert.equal(remote.server.status,"needsSetup");assert.equal(sent.length,0,"a restored required field cannot be satisfied by orphaned vault credentials");assert.equal(restoredStore.isAvailable("remote","new-agent"),false);assert.equal(restoredStore.getPrivate("remote").secretRef,null);
  const replacement="replacement-"+crypto.randomUUID();const replaced=await controller.handle("connector.mcp.credentials.update",{id:"remote",fields:{env:{LEGACY_TOKEN:replacement},headers:{"X-New-Token":replacement}},expectedRevision:restoredStore.revision});assert.equal(replaced.server.status,"ready");assert.deepEqual(await restoredSecrets.read("remote"),{env:{LEGACY_TOKEN:replacement},headers:{"X-New-Token":replacement}});assert.ok(sent.some(headers=>headers["x-new-token"]===replacement));assert.ok(sent.every(headers=>!headers["x-legacy-token"]&&!headers.authorization));
  await controller.handle("connector.mcp.rebind",{id:"oauth",option:sourceRecords.get("oauth").transport,expectedRevision:restoredStore.revision});assert.equal(restoredStore.getPrivate("oauth").secretRef,null);await assert.rejects(oauth.start("oauth"),{code:"MCP_OAUTH_CLIENT_REQUIRED"});assert.equal(fixture.state.registrations.length,0);assert.equal(fixture.state.refreshes,0);
  await controller.handle("connector.mcp.credentials.update",{id:"oauth",fields:{oauthClient:{clientId:"replacement-client"}},expectedRevision:restoredStore.revision});assert.deepEqual(await restoredSecrets.read("oauth"),{oauthClient:{clientId:"replacement-client"}});const signIn=await oauth.start("oauth");assert.equal(new URL(signIn.authorizationUrl).searchParams.get("client_id"),"replacement-client");assert.equal(fixture.state.registrations.length,0);assert.equal(fixture.state.refreshes,0);await oauth.cancel(signIn.signInId);
  assert.equal(JSON.stringify(restoredStore.list()).includes(CANARY),false);assert.equal(JSON.stringify(restoredStore.list()).includes(replacement),false);assert.equal(fs.readFileSync(restoredPaths.encryptedSecretsPath).includes(replacement),false);
 }finally{
  const failures=[];for(const action of[()=>controller?.close(),()=>manager?.close(),()=>oauth?.close(),()=>restoredVault?.close(),()=>vault?.close(),()=>restoredStore?.close(),()=>store?.close(),()=>fixture.close()])try{await action();}catch(error){failures.push(error);}fs.rmSync(root,{recursive:true,force:true});if(failures.length)throw new AggregateError(failures,"backup fixture cleanup");
 }
});
