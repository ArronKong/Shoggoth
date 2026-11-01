#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { validateConnectorParams, validateConnectorResult } = require("../app/core/connector-dto");
const { markOpenConnectorRetired } = require("../app/agent-service/open-connector-retirement");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-controller-unit-")); fs.chmodSync(root,0o700);
  const paths = resolveServicePaths({ homeDir:root, stateRoot:path.join(root,"state"), cacheRoot:path.join(root,"cache"), profileRoot:path.join(root,"profiles"), trustedRoot:root });
  fs.mkdirSync(paths.defaultWorkspaceDir,{recursive:true,mode:0o700}); let now = 100000, failure = false, confirmations = 0, ownerValid = true;
  const store = new NativeMcpStore({paths,now:()=>now}).open(), records = new Map();
  const secrets = { refFor:id=>`mcp-connector:${id}`, get:async ref=>records.get(ref.replace(/^mcp-connector:/,""))||null, read:async id=>records.get(id)||null,
    write:async (id,patch)=>{ const previous=records.get(id)||{}; records.set(id,{...previous,...patch, ...(patch.env?{env:{...previous.env,...patch.env}}:{}), ...(patch.headers?{headers:{...previous.headers,...patch.headers}}:{})}); }, remove:async id=>records.delete(id) };
  const manager = { closeServer:async()=>{}, listTools:async id=> { if (failure || (store.getPrivate(id).setup.requiredFields.includes("env:TOKEN") && records.get(id)?.env?.TOKEN!=="secret-canary")) throw Object.assign(Error("redacted"),{code:"MCP_SERVER_PROBE_FAILED"}); return [{name:"read",inputSchema:{type:"object"}}]; } };
  const item = { registryName:"org/fixture", name:"Fixture", version:"1.0.0", description:"Fixture MCP", repositoryUrl:null, websiteUrl:null, options:[{id:"remote:0",transport:{kind:"remote",protocol:"streamable-http",url:"https://fixture.example/mcp"},fields:[]}] };
  const registry = {get:async(name,version)=>{assert.equal(name,item.registryName);return {...item,version};}, resolveOption:()=>({transport:item.options[0].transport,requiredFields:["env:TOKEN"],configuredFields:[]})};
  const owner = {profileId:"agent-a",agentId:"agent-a",backendId:"shoggoth",sessionKey:"chat-a",transcriptSessionId:"transcript-a",runId:"run-a"};
  const projected = [];
  const make = () => new McpConnectorController({store,secrets,manager,registry,packageLauncher:{prepare:async()=>{}},oauth:{close:async()=>{}},paths,
    now:()=>now,getOwner:async()=>ownerValid?owner:null, getSubjects:async()=>({items:[{profileId:"agent-a",agentId:"agent-a",backendId:"shoggoth",label:"A",enabled:true},{profileId:"agent-b",agentId:"agent-b",backendId:"shoggoth",label:"B",enabled:true}],unavailableBackends:[]}),
    chatUiStore:{upsertConnectionRequest:(owned,request)=>{assert.equal(owned.profileId,"agent-a");projected.push(request);}},
    onComplete:async value=>{assert.equal(JSON.stringify(value).includes("secret-canary"),false);confirmations++;}}).open();
  let controller = make();
  const call = async (method,input={}) => validateConnectorResult(method,await controller.handle(method,validateConnectorParams(method,input)));
  const add = () => call("connector.mcp.add",{source:{kind:"registry",registryName:item.registryName,version:item.version},option:{id:"remote:0"},expectedRevision:store.revision});
  return {root,paths,store,secrets,manager,registry,records,item,owner,projected,call,add,get controller(){return controller;},setFailure:value=>failure=value,setNow:value=>now=value,setOwnerValid:value=>ownerValid=value,confirmations:()=>confirmations,
    restart:async()=>{await controller.close();controller=make();},remove:async()=>{await controller.close();store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test("tool descriptions reuse the readiness snapshot without probes or business calls",async()=>{
  const f=fixture();try{
    let probes=0;
    f.manager.listTools=async()=>{probes++;return [{name:"find_design",description:"Find a design",inputSchema:{type:"object",properties:{private:{default:"hidden-schema"}}}}];};
    const {server}=await f.call("connector.mcp.add",{source:{kind:"custom"},option:{kind:"remote",protocol:"streamable-http",url:"https://display.example/mcp"},expectedRevision:f.store.revision});
    for(let i=0;i<3;i++){
      const view=await f.call("connector.mcp.tools.list",{id:server.id});
      assert.equal(view.available,true);assert.deepEqual(view.items,[{name:"find_design",description:"Find a design"}]);
      assert.equal(JSON.stringify(view).includes("hidden-schema"),false);
    }
    assert.equal(probes,1,"opening or refreshing details never probes");
    await f.restart();
    assert.equal((await f.call("connector.mcp.tools.list",{id:server.id})).available,false,"restart does not advertise a stale cached inventory");
    assert.equal(probes,1);
    await f.call("connector.mcp.verify",{id:server.id});
    assert.equal((await f.call("connector.mcp.tools.list",{id:server.id})).available,true);
    await f.call("connector.mcp.remove",{id:server.id,expectedRevision:f.store.revision});
    await assert.rejects(f.call("connector.mcp.tools.list",{id:server.id}),{code:"MCP_SERVER_NOT_FOUND"});
  }finally{await f.remove();}
});
test("tool descriptions are bounded, secret checked again on read, and invalidated on failure",async()=>{
  const f=fixture();try{
    const secret="new-secret-canary";
    f.manager.listTools=async()=>[{name:"normal",description:"<script>text only</script>"},{name:"long",description:"中".repeat(3000)},
      {name:"private",description:secret},{name:secret,description:"private name"},{name:"normal",description:"duplicate"},{name:"bad\u0001name",description:"control"}];
    const {server}=await f.call("connector.mcp.add",{source:{kind:"custom"},option:{kind:"remote",protocol:"streamable-http",url:"https://display.example/mcp"},expectedRevision:f.store.revision});
    f.controller.assertSecretSafe=value=>{if(value.includes(secret))throw Error("secret");};
    const view=await f.call("connector.mcp.tools.list",{id:server.id});
    assert.equal(view.available,true);assert.equal(view.totalCount,6);assert.equal(view.items.length,3);
    assert.equal(view.items[0].description,"<script>text only</script>");
    assert.ok(Buffer.byteLength(view.items[1].description)<=2048);assert.equal(view.items[2].description,"");
    assert.equal(JSON.stringify(view).includes(secret),false);
    f.manager.listTools=async()=>{throw Object.assign(Error("private"),{code:"MCP_AUTH_REQUIRED"});};
    await f.call("connector.mcp.verify",{id:server.id});
    const failed=await f.call("connector.mcp.tools.list",{id:server.id});assert.equal(failed.available,false);assert.deepEqual(failed.items,[]);
    assert.throws(()=>validateConnectorParams("connector.mcp.tools.list",{id:server.id,refresh:true}),/invalid connector/);
    assert.throws(()=>validateConnectorResult("connector.mcp.tools.list",{...view,items:[{name:"x",description:"ok",inputSchema:{}}]}),/invalid connector/);
  }finally{await f.remove();}
});
test("provider access denial preserves anonymous configuration and retries the same record after access is restored",async()=>{
  const f=fixture();try{
    f.manager.listTools=async()=>{throw Object.assign(Error("provider-private-canary"),{code:"MCP_SERVER_ACCESS_DENIED"});};
    const {server}=await f.call("connector.mcp.add",{source:{kind:"custom"},name:"Provider",option:{kind:"remote",protocol:"streamable-http",url:"https://provider.example/mcp"},expectedRevision:f.store.revision});
    assert.equal(server.status,"failed");assert.equal(server.auth.kind,"none");
    assert.equal(server.lastCheck.errorCode,"MCP_SERVER_ACCESS_DENIED");assert.equal(server.lastCheck.toolCount,0);
    assert.equal(f.store.getPrivate(server.id).secretRef,null);assert.equal(f.records.size,0);
    assert.equal((await f.call("connector.mcp.tools.list",{id:server.id})).available,false);
    f.manager.listTools=async()=>[{name:"read",description:"Read fixture",inputSchema:{type:"object"}}];
    const recovered=await f.call("connector.mcp.verify",{id:server.id});
    assert.equal(recovered.server.id,server.id);assert.equal(recovered.server.status,"ready");
    assert.equal(recovered.server.auth.kind,"none");assert.equal(f.store.list().servers.length,1);
    assert.equal((await f.call("connector.mcp.tools.list",{id:server.id})).available,true);
  }finally{await f.remove();}
});
test("n8n preset defaults pass real controller admission and preserve private environment",async()=>{
  const f=fixture();try{
    const preset=require("../app/agent-service/data/mcp-featured-presets.json").find(value=>value.id==="n8n");
    const prepared=[];f.controller.packageLauncher.prepare=async transport=>{prepared.push(transport);};
    const result=await f.call("connector.mcp.add",{source:{kind:"custom"},name:preset.name,option:preset.transport,fields:{env:{...preset.defaults.env}},expectedRevision:f.store.revision});
    assert.equal(result.server.status,"ready");assert.deepEqual(prepared,[preset.transport]);
    const expected={LOG_LEVEL:"error",DISABLE_CONSOLE_OUTPUT:"true",N8N_MCP_TELEMETRY_DISABLED:"true"};
    assert.deepEqual((await f.secrets.read(result.server.id)).env,expected);
    assert.deepEqual(f.store.getPrivate(result.server.id).transport,{...preset.transport,packageArgs:[]},"default environment values never become transport arguments");
    const secret="n8n-api-key-canary";
    await assert.rejects(f.call("connector.mcp.add",{source:{kind:"custom"},option:{...preset.transport,packageArgs:[secret]},fields:{env:{...preset.defaults.env,N8N_API_KEY:secret}},expectedRevision:f.store.revision}),{code:"MCP_SECRET_INVALID"});
    assert.equal(prepared.length,1,"a real credential in argv is rejected before preparation");
  }finally{await f.remove();}
});
test("failed setup retries same record; credentials stay private and exclusions survive",async()=>{
  const f=fixture();try{
    const first=await f.add();assert.equal(first.server.status,"failed");const id=first.server.id;
    await f.call("connector.mcp.agents.set",{id,disabledProfileIds:["agent-b"],expectedRevision:f.store.revision});
    const ready=await f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"secret-canary"}},expectedRevision:f.store.revision});
    assert.equal(ready.server.id,id);assert.equal(ready.server.status,"ready");assert.deepEqual(ready.server.disabledProfileIds,["agent-b"]);
    assert.equal(JSON.stringify(f.store.list()).includes("secret-canary"),false);assert.equal(JSON.stringify(f.store.list()).includes("secretRef"),false);
    assert.equal(f.store.list().servers.length,1);
    await assert.rejects(f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"secret-canary"}},expectedRevision:1}),{code:"MCP_REGISTRY_REVISION_CONFLICT"});
  }finally{await f.remove();}
});
test("OAuth failure preserves only recognized public reasons in connector status",async()=>{
  const f=fixture();try{
    const {server:{id}}=await f.add();
    for(const errorCode of ["MCP_OAUTH_REGISTRATION_DENIED","MCP_OAUTH_CALLBACK_UNAVAILABLE","MCP_AUTH_REQUIRED"]){
      await f.controller.authorizationChanged({id,status:"failed",errorCode});
      assert.equal(f.store.get(id).lastCheck.errorCode,errorCode);
      validateConnectorResult("connector.mcp.list",f.store.list());
    }
    await f.controller.authorizationChanged({id,status:"failed",errorCode:"secret-canary"});
    assert.equal(f.store.get(id).lastCheck.errorCode,"MCP_OAUTH_FAILED");
    assert.equal(JSON.stringify(f.store.list()).includes("secret-canary"),false);
    await f.controller.authorizationChanged({id,status:"signedOut",errorCode:"secret-canary"});
    assert.equal(f.store.get(id).lastCheck.errorCode,"MCP_SIGN_IN_REQUIRED");
  }finally{await f.remove();}
});
test("Run availability freezes additions and immediately narrows revocation",async()=>{
  const f=fixture();try{
    const result=await f.add(),id=result.server.id;await f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"secret-canary"}},expectedRevision:f.store.revision});
    f.controller.captureRun({id:"run-a",profileId:"agent-a"});assert.equal(f.controller.available("agent-a","run-a").length,1);
    const added=await f.call("connector.mcp.add",{source:{kind:"custom"},option:{kind:"remote",protocol:"streamable-http",url:"https://another.example/mcp"},expectedRevision:f.store.revision});
    assert.equal(f.controller.available("agent-a","run-a").some(s=>s.id===added.server.id),false);
    assert.equal(f.controller.available("future-agent").length,2);
    await f.call("connector.mcp.agents.set",{id,disabledProfileIds:["agent-a"],expectedRevision:f.store.revision});
    assert.equal(f.controller.available("agent-a","run-a").length,0);assert.throws(()=>f.controller.assertAvailable(id,"agent-a","run-a"),{code:"MCP_CONNECTOR_ACCESS_DENIED"});
    assert.equal(f.controller.available("agent-b").some(s=>s.id===id),true);
  }finally{await f.remove();}
});
test("request completion validates target, owner, expiry and duplicate delivery",async()=>{
  const f=fixture();try{
    const added=await f.add(),id=added.server.id;
    const request=await f.controller.request({serverId:id,field:"env:TOKEN",purpose:"Read fixture"},f.owner);
    const duplicate=await f.controller.request({serverId:id,field:"env:TOKEN",purpose:"Read fixture"},f.owner);assert.equal(duplicate.requestId,request.requestId);
    assert.equal(request.expiresAt-request.createdAt,86400000);assert.equal(JSON.stringify(request).includes("secret-canary"),false);
    await assert.rejects(f.call("connector.mcp.request.complete",{requestId:request.requestId,fields:{headers:{Authorization:"secret-canary"}}}),{code:"MCP_REQUEST_TARGET_MISMATCH"});
    await assert.rejects(f.call("connector.mcp.request.complete",{requestId:request.requestId,fields:{env:{OTHER:"secret-canary"}}}),{code:"MCP_REQUEST_TARGET_MISMATCH"});
    await assert.rejects(f.call("connector.mcp.request.complete",{requestId:request.requestId,serverId:"wrong-server"}),{code:"MCP_REQUEST_TARGET_MISMATCH"});
    f.setFailure(true);await assert.rejects(f.call("connector.mcp.request.complete",{requestId:request.requestId,fields:{env:{TOKEN:"secret-canary"}}}),{code:"MCP_SERVER_PROBE_FAILED"});
    assert.equal(f.controller.listRequests(f.owner).items[0].status,"pending");
    f.setFailure(false);f.setOwnerValid(false);await assert.rejects(f.call("connector.mcp.request.complete",{requestId:request.requestId}),{code:"MCP_REQUEST_ACCESS_DENIED"});f.setOwnerValid(true);
    const done=await f.call("connector.mcp.request.complete",{requestId:request.requestId,fields:{env:{TOKEN:"secret-canary"}}});assert.equal(done.status,"completed");
    assert.equal((await f.call("connector.mcp.request.complete",{requestId:request.requestId})).status,"completed");assert.equal(f.confirmations(),1);
    const another = await f.controller.request({url:"https://fixture.example/mcp",purpose:"Connect"},{...f.owner,runId:"connection-fields"});
    await assert.rejects(f.call("connector.mcp.request.complete",{requestId:another.requestId,serverId:id,fields:{env:{TOKEN:"secret-canary"}}}),{code:"MCP_REQUEST_TARGET_MISMATCH"});
    const wrong=await f.controller.request({url:"https://different.example/mcp",purpose:"Connect"},{...f.owner,runId:"run-2"});
    await assert.rejects(f.call("connector.mcp.request.complete",{requestId:wrong.requestId,serverId:id}),{code:"MCP_REQUEST_TARGET_MISMATCH"});
    const expired=await f.controller.request({url:"https://fixture.example/mcp",purpose:"Connect"},{...f.owner,runId:"run-3"});f.setNow(expired.expiresAt);
    await assert.rejects(f.call("connector.mcp.request.complete",{requestId:expired.requestId,serverId:id}),{code:"MCP_REQUEST_EXPIRED"});
    await f.restart();assert.equal(f.controller.listRequests(f.owner).items.find(r=>r.requestId===request.requestId).status,"completed");
    const raw=fs.readFileSync(f.controller.requestsPath,"utf8");assert.equal(raw.includes("secret-canary"),false);
  }finally{await f.remove();}
});
test("signin cancellation returns a public status and rebind preserves identity/exclusions",async()=>{
  const f=fixture();try{
    const added=await f.add(),id=added.server.id;let signinStatus="pending";
    f.controller.oauth={start:async serverId=>({id:serverId,signInId:"signin-one",status:signinStatus,authorizationUrl:"https://auth.example/authorize",redirectUri:"http://127.0.0.1:12345/oauth/callback",expiresAt:200000,errorCode:null,flow:"redirect",userCode:null,installationUrl:null}),get:signInId=>({id,signInId,status:signinStatus,authorizationUrl:null,redirectUri:"http://127.0.0.1:12345/oauth/callback",expiresAt:200000,errorCode:null,flow:"redirect",userCode:null,installationUrl:null}),cancel:async()=>{signinStatus="cancelled";return true;},close:async()=>{}};
    assert.equal((await f.call("connector.mcp.signin.start",{id})).status,"pending");
    assert.equal((await f.call("connector.mcp.signin.cancel",{signInId:"signin-one"})).status,"cancelled");
    await f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"secret-canary"}},expectedRevision:f.store.revision});
    await f.call("connector.mcp.agents.set",{id,disabledProfileIds:["agent-b"],expectedRevision:f.store.revision});
    f.store.update({id,patch:{enabled:false},expectedRevision:f.store.revision});
    const command=path.join(f.root,"fixture-server");fs.writeFileSync(command,"#!/bin/sh\nexit 0\n",{mode:0o700});
    const rebound=await f.call("connector.mcp.rebind",{id,option:{kind:"stdio-command",command,args:[],cwd:""},expectedRevision:f.store.revision});
    assert.equal(rebound.server.id,id);assert.equal(rebound.server.status,"ready");assert.deepEqual(rebound.server.disabledProfileIds,["agent-b"]);
    assert.equal(f.store.getPrivate(id).transport.cwd,f.paths.defaultWorkspaceDir);
    assert.equal(Object.hasOwn(rebound.server.transport,"args"),false);
    await assert.rejects(f.call("connector.mcp.rebind",{id,option:{kind:"stdio-command",command,args:["--token","secret-canary"],cwd:f.paths.defaultWorkspaceDir},expectedRevision:f.store.revision}),{code:"MCP_SECRET_INVALID"});
  }finally{await f.remove();}
});
test("retirement inventories opaque bytes without rewriting legacy files",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-retirement-unit-"));fs.chmodSync(root,0o700);
  try{const stateDir=path.join(root,"state"),connectorsDir=path.join(stateDir,"connectors");fs.mkdirSync(path.join(connectorsDir,"runtime"),{recursive:true,mode:0o700});
    const files={"access-v1.json":Buffer.from("not-json-opaque-data"),"external-selection-v1.sqlite":Buffer.from([0,1,255,0]),"runtime/version.bin":Buffer.from("fixed-version")};
    for(const [name,bytes]of Object.entries(files))fs.writeFileSync(path.join(connectorsDir,name),bytes,{mode:0o600});
    const receipt=markOpenConnectorRetired({stateDir,connectorsDir,trustedRoot:root},{now:()=>1000});assert.equal(receipt.files.length,3);
    for(const [name,bytes]of Object.entries(files)){assert.deepEqual(fs.readFileSync(path.join(connectorsDir,name)),bytes);assert.equal(receipt.files.find(f=>f.path===name).sha256,crypto.createHash("sha256").update(bytes).digest("hex"));}
    assert.deepEqual(markOpenConnectorRetired({stateDir,connectorsDir,trustedRoot:root},{now:()=>2000}),receipt);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail("fixture did not reach expected boundary");}
test("queued stale credential mutations never write secrets; removal cannot recreate them",async()=>{
  const f=fixture();try{
    const {server:{id}}=await f.add();const original=f.secrets.write,gate=deferred();let writes=0;
    f.secrets.write=async(...args)=>{writes++;await gate.promise;return original(...args);};
    const revision=f.store.revision;
    const first=f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"secret-canary"}},expectedRevision:revision});
    await until(()=>writes===1);assert.equal(f.store.get(id).status,"checking");assert.equal(f.store.isAvailable(id,"agent-a"),false);
    const stale=f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"stale-secret"}},expectedRevision:revision});
    const staleOutcome=assert.rejects(stale,{code:"MCP_REGISTRY_REVISION_CONFLICT"});
    gate.resolve();await first;await staleOutcome;assert.equal(writes,1);assert.equal(f.records.get(id).env.TOKEN,"secret-canary");
    const pendingGate=deferred();f.secrets.write=async(...args)=>{writes++;await pendingGate.promise;return original(...args);};
    const pending=f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"replacement-secret"}},expectedRevision:f.store.revision});
    await until(()=>writes===2);
    const removal=f.call("connector.mcp.remove",{id,expectedRevision:f.store.revision});
    const rejected=assert.rejects(pending,{code:"MCP_SERVER_NOT_FOUND"});
    pendingGate.resolve();await removal;await rejected;assert.equal(f.store.get(id),null);assert.equal(f.records.has(id),false);
  }finally{await f.remove();}
});
test("a probe from an older transport generation cannot publish ready",async()=>{
  const f=fixture();try{
    const {server:{id}}=await f.add(),oldProbe=deferred(),newProbe=deferred();let probes=0;
    f.manager.listTools=async()=>{probes++;return probes===1?oldProbe.promise:newProbe.promise;};
    const old=f.call("connector.mcp.verify",{id});const rejected=assert.rejects(old,{code:"MCP_REGISTRY_REVISION_CONFLICT"});await until(()=>probes===1);
    const rebound=f.call("connector.mcp.rebind",{id,option:{kind:"remote",protocol:"streamable-http",url:"https://new.example/mcp"},expectedRevision:f.store.revision});
    await until(()=>probes===2);oldProbe.resolve([{name:"stale"}]);await rejected;
    assert.equal(f.store.get(id).status,"checking");assert.equal(f.store.getPrivate(id).transport.url,"https://new.example/mcp");
    newProbe.reject(Object.assign(Error("private failure"),{code:"MCP_SERVER_PROBE_FAILED"}));assert.equal((await rebound).server.status,"failed");
  }finally{await f.remove();}
});
test("Registry retry and update preserve discovered OAuth; null secret refs stay disconnected",async()=>{
  const f=fixture();try{
    const {server:{id}}=await f.add();f.records.set(id,{env:{TOKEN:"secret-canary"},oauthClient:{client_id:"dcr-client"},oauthToken:{access_token:"private-oauth-token"}});
    f.store.update({id,patch:{auth:{kind:"oauth-dcr"},secretRef:f.secrets.refFor(id)},expectedRevision:f.store.revision});
    assert.equal((await f.add()).server.auth.kind,"oauth-dcr");
    assert.equal((await f.call("connector.mcp.update",{id,version:"1.0.1",expectedRevision:f.store.revision})).server.auth.kind,"oauth-dcr");
    assert.equal(f.records.get(id).oauthToken.access_token,"private-oauth-token");
    f.store.update({id,patch:{secretRef:null,auth:{kind:"none"},setup:{requiredFields:["env:TOKEN"],configuredFields:[]}},expectedRevision:f.store.revision});
    const updated=await f.call("connector.mcp.update",{id,version:"1.0.2",expectedRevision:f.store.revision});
    assert.equal(f.store.getPrivate(id).secretRef,null);assert.equal(updated.server.auth.kind,"none");
  }finally{await f.remove();}
});
test("Run revocations remain narrowed after re-enable and OAuth invalidates pending probes",async()=>{
  const f=fixture();try{
    const {server:{id}}=await f.add();await f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"secret-canary"}},expectedRevision:f.store.revision});
    f.controller.captureRun({id:"frozen",profileId:"agent-a"});
    await f.call("connector.mcp.agents.set",{id,disabledProfileIds:["agent-a"],expectedRevision:f.store.revision});
    await f.call("connector.mcp.agents.set",{id,disabledProfileIds:[],expectedRevision:f.store.revision});
    assert.equal(f.controller.available("agent-a","frozen").length,0);assert.equal(f.controller.available("agent-a").length,1);
    f.controller.captureRun({id:"oauth-frozen",profileId:"agent-a"});const gate=deferred();let probes=0;f.manager.listTools=async()=>{probes++;return gate.promise;};
    const probe=f.call("connector.mcp.verify",{id});const rejected=assert.rejects(probe,{code:"MCP_REGISTRY_REVISION_CONFLICT"});await until(()=>probes===1);
    await f.controller.authorizationChanged({id,status:"signedOut"});assert.equal(f.store.get(id).status,"signedOut");assert.equal(f.controller.available("agent-a","oauth-frozen").length,0);
    gate.resolve([{name:"old"}]);await rejected;assert.equal(f.store.get(id).status,"signedOut");
    f.manager.listTools=async()=>[];await f.controller.authorizationChanged({id,status:"authorized"});assert.equal(f.store.get(id).status,"ready");assert.equal(f.controller.available("agent-a","oauth-frozen").length,0);
  }finally{await f.remove();}
});
test("request ledger rejects unknown public/owner fields, duplicates and malformed scope",async()=>{
  const f=fixture();try{
    await f.controller.request({url:"https://fixture.example/mcp",purpose:"Connect"},f.owner);await f.controller.close();
    const valid=JSON.parse(fs.readFileSync(f.controller.requestsPath,"utf8"));
    const variants=[d=>d.requests[0].credentials={TOKEN:"must-not-load"},d=>d.requests[0].owner.secret="must-not-load",d=>d.requests.push(d.requests[0]),d=>d.requests[0].expiresAt+=86400000,d=>d.requests[0].fingerprint="bad",d=>d.requests[0].owner.sessionKey="bad\nkey",d=>d.extra=true];
    for(const change of variants){const data=structuredClone(valid);change(data);fs.writeFileSync(f.controller.requestsPath,JSON.stringify(data),{mode:0o600});assert.throws(()=>f.controller.open(),{code:"MCP_REQUEST_STORE_CORRUPT"});}
    fs.writeFileSync(f.controller.requestsPath,JSON.stringify(valid),{mode:0o600});f.controller.open();assert.equal(f.controller.listRequests(f.owner).items.length,1);
  }finally{await f.remove();}
});
test("a failed credential write never activates an orphaned vault record",async()=>{
  const f=fixture();try{
    const {server:{id}}=await f.add();assert.equal(f.store.getPrivate(id).secretRef,null);
    f.records.set(id,{oauthToken:{access_token:"orphan-oauth"},headers:{Authorization:"orphan-header"}});
    const original=f.secrets.write;let probes=0;f.manager.listTools=async()=>{probes++;return [];};
    f.secrets.write=async(key,fields)=>{await original(key,fields);throw Object.assign(Error("fixture private write failure"),{code:"FIXTURE_SECRET_WRITE_FAILED"});};
    await assert.rejects(f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"first-attempt"}},expectedRevision:f.store.revision}),{code:"FIXTURE_SECRET_WRITE_FAILED"});
    assert.equal(f.store.getPrivate(id).secretRef,null);assert.equal(f.store.get(id).status,"failed");assert.equal(probes,0);
    f.secrets.write=original;
    await f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"secret-canary"}},expectedRevision:f.store.revision});
    assert.deepEqual(f.records.get(id),{env:{TOKEN:"secret-canary"}});assert.equal(f.store.get(id).status,"ready");
  }finally{await f.remove();}
});

test("OAuth request cards normalize aliases and complete one private field without erasing its sibling",async()=>{
  const f=fixture();try{
    const {server:{id}}=await f.add();
    await f.call("connector.mcp.credentials.update",{id,fields:{env:{TOKEN:"secret-canary"},oauthClient:{clientId:"registered-client",clientSecret:"original-secret"}},expectedRevision:f.store.revision});
    assert.ok(f.store.get(id).setup.configuredFields.includes("oauthClient:clientId"));assert.ok(f.store.get(id).setup.configuredFields.includes("oauthClient:clientSecret"));
    const requests=await Promise.all([f.controller.request({serverId:id,field:"oauthClient.client_secret",purpose:"Rotate client secret"},f.owner),f.controller.request({serverId:id,field:"oauthClient:clientSecret",purpose:"Rotate client secret"},f.owner)]);
    const request=requests[0];assert.equal(requests[1].requestId,request.requestId);assert.deepEqual(request.requiredFields,[{name:"clientSecret",label:"oauthClient:clientSecret",kind:"oauthClient"}]);
    assert.throws(()=>validateConnectorParams("connector.mcp.request.complete",{requestId:request.requestId,fields:{oauthClient:{clientSecret:"new-secret",clientId:"injected-client"}}}));
    assert.throws(()=>validateConnectorParams("connector.mcp.request.complete",{requestId:request.requestId,fields:{oauthClient:{clientSecret:"new-secret",redirectUri:"https://injected.example"}}}));
    assert.throws(()=>validateConnectorParams("connector.mcp.request.complete",{requestId:request.requestId,fields:{oauthClient:{client_secret:"new-secret"}}}));
    assert.throws(()=>validateConnectorParams("connector.mcp.credentials.update",{id,expectedRevision:f.store.revision,fields:{oauthClient:{clientSecret:"new-secret"}}}));
    await assert.rejects(f.call("connector.mcp.request.complete",{requestId:request.requestId,fields:{oauthClient:{clientId:"wrong-field"}}}),{code:"MCP_REQUEST_TARGET_MISMATCH"});
    f.records.get(id).oauthClient.issuer="https://issuer.example";
    await f.call("connector.mcp.request.complete",{requestId:request.requestId,fields:{oauthClient:{clientSecret:"replacement-secret"}}});
    assert.equal(f.records.get(id).oauthClient.clientId,"registered-client");assert.equal(f.records.get(id).oauthClient.clientSecret,"replacement-secret");assert.equal(f.records.get(id).oauthClient.issuer,"https://issuer.example");
    const raw=fs.readFileSync(f.controller.requestsPath,"utf8");for(const value of ["original-secret","replacement-secret","registered-client"])assert.equal(raw.includes(value),false);
    // OAuth SDK sessions persisted snake_case before a configuredFields projection existed.
    f.records.set(id,{oauthClient:{client_id:"sdk-client",client_secret:"sdk-secret",issuer:"https://issuer.example"}});
    f.store.update({id,patch:{setup:{requiredFields:[],configuredFields:[]}},expectedRevision:f.store.revision});
    const legacy=await f.controller.request({serverId:id,field:"oauthClient:client_secret",purpose:"Rotate SDK secret"},{...f.owner,runId:"sdk-run"});
    assert.equal(legacy.requiredFields[0].name,"clientSecret");assert.ok(f.store.get(id).setup.configuredFields.includes("oauthClient:clientId"));
    await f.call("connector.mcp.request.complete",{requestId:legacy.requestId,fields:{oauthClient:{clientSecret:"sdk-replacement"}}});
    assert.equal(f.records.get(id).oauthClient.clientId,"sdk-client");assert.equal(f.records.get(id).oauthClient.clientSecret,"sdk-replacement");assert.equal(Object.hasOwn(f.records.get(id).oauthClient,"client_secret"),false);
    f.store.update({id,patch:{secretRef:null,setup:{requiredFields:["oauthClient:clientSecret"],configuredFields:[]}},expectedRevision:f.store.revision});
    const detached=await f.controller.request({serverId:id,field:"oauthClient:clientSecret",purpose:"No orphan fallback"},{...f.owner,runId:"detached-run"});
    await assert.rejects(f.call("connector.mcp.request.complete",{requestId:detached.requestId,fields:{oauthClient:{clientSecret:"must-not-bind"}}}),{code:"MCP_SECRET_INVALID"});assert.equal(f.store.getPrivate(id).secretRef,null);
  }finally{await f.remove();}
});
test("obvious secret flags are rejected in command and package launcher argv",async()=>{
  const f=fixture();try{
    const command=path.join(f.root,"fixture-command");fs.writeFileSync(command,"#!/bin/sh\nexit 0\n",{mode:0o700});let preparations=0;f.controller.packageLauncher.prepare=async()=>{preparations++;};
    for(const args of [["--token","secret-value"],["--token=secret-value"],["--api-key=secret-value"],["--password","secret-value"]]){
      for(const option of [{kind:"stdio-command",command,args,cwd:f.paths.defaultWorkspaceDir},{kind:"stdio-package",registryType:"npm",identifier:"fixture-package",version:"1.2.3",packageArgs:args},{kind:"stdio-command",command:"npx",args:["-y","fixture-package@1.2.3",...args],cwd:f.paths.defaultWorkspaceDir}])await assert.rejects(f.call("connector.mcp.add",{source:{kind:"custom"},option,expectedRevision:f.store.revision}),{code:"MCP_SECRET_INVALID"});
    }
    assert.equal(preparations,0);assert.equal(f.store.list().servers.length,0);
  }finally{await f.remove();}
});
