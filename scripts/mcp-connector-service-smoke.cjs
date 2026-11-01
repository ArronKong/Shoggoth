#!/usr/bin/env node
"use strict";
// Real Service -> authenticated IPC -> ShoggothBackend -> management REST.
// Every authority directory and OAuth provider belongs to this disposable fixture.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { startFixture, CANARY } = require("./fixtures/mcp-connector-http-fixture.cjs");
const { validateConnectorResult } = require("../app/core/connector-dto");
async function start() {
  const provider = await startFixture();
  const callbackProbe = require("node:net").createServer();
  await new Promise(resolve => callbackProbe.listen(0,"127.0.0.1",resolve));
  const callbackPort = callbackProbe.address().port;
  await new Promise(resolve => callbackProbe.close(resolve));
  let f;
  try { f = await startInspirationFixture({ codexFakeEnv: { CODEX_FAKE_AUTOCOMPLETE_ALL:"1" }, serviceOptions: { autoSparkNotes:false,
    mcpOAuthCallbackPort:callbackPort,
    setCronTimer:()=>1,clearCronTimer(){},setProactiveTimer:()=>1,clearProactiveTimer(){} } }); }
  catch (error) { await provider.close(); throw error; }
  const rest = async (endpoint, body, {origin=f.url, status=200}={}) => {
    const response = await fetch(`${f.url}/__api/connectors/${endpoint}`, body === undefined ? {} : {
      method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify(body) });
    const text = await response.text(); let data; try { data=JSON.parse(text); } catch { data={error:text}; } assert.equal(response.status,status,JSON.stringify(data));
    assert.equal(JSON.stringify(data).includes(CANARY),false,"secret in management response"); return data;
  };
  const close = async()=>{await f.close();await provider.close();};
  return {...f,provider,rest,close};
}
async function smoke() {
  const f=await start();
  try {
    const registry=f.service.mcpConnectorController.registry,registryFetch=registry.fetch;
    const registryEntry=require("./fixtures/mcp-registry/io.github.github__github-mcp-server.json");
    const registryBefore=f.service.nativeMcpStore.list();let registryReads=0;
    registry.fetch=async()=>{
      registryReads++;await new Promise(resolve=>setTimeout(resolve,5200));
      return new Response(JSON.stringify({servers:[registryEntry],metadata:{}}));
    };
    try {
      const page=await f.rest("mcp/registry?search=slow-registry-first-page");
      validateConnectorResult("connector.mcp.registry.list",page);
      assert.equal(page.items[0].name,"GitHub");assert.equal(registryReads,1);
      assert.deepEqual(f.service.nativeMcpStore.list(),registryBefore,"directory reads must not change installed connectors");
      let registryAborted=false;
      registry.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{
        signal.addEventListener("abort",()=>{registryAborted=true;reject(signal.reason);},{once:true});
      });
      const unavailable=await f.rest("mcp/registry?search=registry-network-deadline",undefined,{status:503});
      assert.equal(registryAborted,true,"the Registry network deadline must settle before the IPC deadline");
      assert.equal(unavailable.code,"MCP_REGISTRY_UNAVAILABLE");
      assert.deepEqual(f.service.nativeMcpStore.list(),registryBefore);
    }finally{registry.fetch=registryFetch;}
    let snapshot=await f.rest("mcp/list"); assert.deepEqual(snapshot.servers,[]);
    assert.ok((await f.rest("mcp/subjects")).items.length);
    await f.rest("mcp/add",{source:{kind:"custom"},option:{kind:"remote",protocol:"streamable-http",url:`${f.provider.origin}/public`},expectedRevision:snapshot.revision},{origin:"https://untrusted.example",status:403});
    let added=await f.rest("mcp/add",{source:{kind:"custom"},name:"Service fixture",option:{kind:"remote",protocol:"streamable-http",url:`${f.provider.origin}/public`},expectedRevision:snapshot.revision});
    validateConnectorResult("connector.mcp.add",added); assert.equal(added.server.status,"ready");
    const id=added.server.id; assert.deepEqual(added.server.disabledProfileIds,[]);
    const manager=f.service.nativeMcpClientManager, originalListTools=manager.listTools, originalCallTool=manager.callTool;
    const toolSnapshot=f.service.nativeMcpStore.list();
    manager.listTools=async()=>assert.fail("reading tool descriptions must not probe");
    manager.callTool=async()=>assert.fail("reading tool descriptions must not call business tools");
    try {
      const tools=await f.rest(`mcp/tools?id=${encodeURIComponent(id)}`);
      validateConnectorResult("connector.mcp.tools.list",tools);
      assert.equal(tools.available,true);assert.ok(tools.items.some(item=>item.name==="echo"));
      assert.ok(tools.items.every(item=>Object.keys(item).sort().join(",")==="description,name"));
      await f.rest(`mcp/tools?id=${encodeURIComponent(id)}&refresh=true`,undefined,{status:400});
      await f.rest("mcp/tools",{id},{status:404});
      assert.deepEqual(f.service.nativeMcpStore.list(),toolSnapshot,"description reads preserve configuration, permissions and revision");
    } finally { manager.listTools=originalListTools;manager.callTool=originalCallTool; }
    const profileId=f.service.productStore.listAgentProfiles()[0].id;
    assert.ok(f.service.mcpConnectorController.available(profileId).some(item=>item.id===id));
    const created=await f.ipc("agent.create",{operationId:crypto.randomUUID(),backendId:"shoggoth",name:"New connector acceptance Agent",defaultCwd:null,createdAt:Date.now()});
    assert.ok(f.service.mcpConnectorController.available(created.profile.id).some(item=>item.id===id),"new actual Agent automatically receives ready connectors");
    const session=f.service.chatSessionStore.listSessions().find(value=>value.profileId===profileId);
    const request=await f.service.mcpConnectorController.request({url:`${f.provider.origin}/public`,purpose:"Service end-to-end acceptance"},{backendId:"shoggoth",agentId:profileId,profileId,sessionKey:session.sessionKey,transcriptSessionId:session.id,runId:"fixture-run"});
    const cards=await f.rest(`mcp/requests?backendId=shoggoth&agentId=${profileId}&sessionKey=${encodeURIComponent(session.sessionKey)}`);
    assert.equal(cards.items[0].requestId,request.requestId);
    added=await f.rest("mcp/agents",{id,disabledProfileIds:[profileId],expectedRevision:added.revision});
    assert.equal(f.service.mcpConnectorController.available(profileId).some(item=>item.id===id),false);
    assert.ok(f.service.mcpConnectorController.available("future-agent").some(item=>item.id===id));
    await f.rest("mcp/agents",{id,disabledProfileIds:[],expectedRevision:1},{status:409});
    const old=await f.rest("catalog",undefined,{status:410}); assert.equal(old.code,"OPEN_CONNECTOR_RETIRED");
    snapshot=await f.rest("mcp/list");
    const authed=await f.rest("mcp/add",{source:{kind:"custom"},name:"Header fixture",option:{kind:"remote",protocol:"streamable-http",url:`${f.provider.origin}/mcp`},fields:{headers:{Authorization:`Bearer ${CANARY}`}},expectedRevision:snapshot.revision});
    assert.equal(authed.server.status,"ready");
    assert.equal((await f.service.nativeMcpClientManager.callTool(authed.server.id,"echo",{value:"service-fixture"})).content[0].text,"service-fixture");
    // Ciphertext and public authorities must not contain any supplied value.
    const authorities=[f.paths.encryptedSecretsPath,f.paths.nativeMcpRegistryPath,f.service.mcpConnectorController.requestsPath].filter(Boolean);
    for(const file of authorities)if(fs.existsSync(file))assert.equal(fs.readFileSync(file,"utf8").includes(CANARY),false,path.basename(file));
    const context=JSON.stringify(f.service.nativeMcpStore.list());assert.equal(context.includes(CANARY),false);
    snapshot=await f.rest("mcp/list");
    const failed=await f.rest("mcp/add",{source:{kind:"custom"},name:"Failed isolated fixture",option:{kind:"remote",protocol:"streamable-http",url:`${f.provider.origin}/redirect`},expectedRevision:snapshot.revision});
    assert.equal(failed.server.status,"failed");
    const accepted=await f.ipc("chat.send",{operationId:crypto.randomUUID(),sessionKey:session.sessionKey,prompt:"Verify ordinary chat after one connector fails.",createdAt:Date.now()});
    await f.service.workRunCoordinator.waitForTerminal(accepted.run.id);
    const finalRun=f.service.workDispatcher.getRun(accepted.run.id);assert.equal(finalRun.status,"completed",JSON.stringify(finalRun));
    const history=await f.ipc("chat.history",{sessionKey:session.sessionKey,cursor:null,limit:100});assert.equal(JSON.stringify(history).includes(CANARY),false);
    const contract=f.service.workRunCoordinator.runExecutionContracts.get(accepted.run.id);
    if(contract?.contextSnapshotId)assert.equal(JSON.stringify(f.service.contextSnapshotStore.get(profileId,contract.contextSnapshotId)).includes(CANARY),false);
    const snapshots=[];const walk=dir=>{if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(e.name.startsWith("ctx-")&&e.name.endsWith(".json"))snapshots.push(file);}};
    walk(f.paths.stateDir);assert.ok(snapshots.length,"real run must persist a compiled context snapshot");
    for(const file of snapshots)assert.equal(fs.readFileSync(file,"utf8").includes(CANARY),false,"secret in compiled context");
    snapshot=await f.rest("mcp/list");
    const oauthServer=await f.rest("mcp/add",{source:{kind:"custom"},name:"Delayed OAuth fixture",option:{kind:"remote",protocol:"streamable-http",url:`${f.provider.origin}/mcp`},expectedRevision:snapshot.revision});
    assert.equal(oauthServer.server.status,"signedOut");
    const oauth=f.service.mcpConnectorController.oauth, upstreamFetch=oauth.fetch;
    oauth.fetch=async(input,init)=>{
      if(new URL(input).pathname==="/register")await new Promise(resolve=>setTimeout(resolve,5200));
      return upstreamFetch(input,init);
    };
    const opaqueToken=`fixture-user:fixture-grant:${CANARY}`, refreshedToken=`fixture-user:fixture-grant:refreshed-${CANARY}`;
    f.provider.state.accessToken=opaqueToken; f.provider.state.refreshAccessToken=refreshedToken;
    const signIn=await f.rest("mcp/signin",{id:oauthServer.server.id});
    assert.equal(signIn.status,"pending");
    const redirect=await fetch(signIn.authorizationUrl,{redirect:"manual"});
    assert.equal((await fetch(redirect.headers.get("location"))).status,200);
    assert.equal((await f.rest(`mcp/signin-status?signInId=${signIn.signInId}`)).status,"authorized");
    assert.equal((await f.rest("mcp/verify",{id:oauthServer.server.id})).server.status,"ready");
    assert.equal(f.provider.state.registrations.length,1);
    assert.equal(fs.readFileSync(f.paths.encryptedSecretsPath,"utf8").includes(opaqueToken),false);
    // A fresh client reads the encrypted envelope by the real registry's saved reference.
    const { McpOAuthClient }=require("../app/agent-service/mcp-oauth-client");
    const reopenedOAuth=new McpOAuthClient({store:f.service.nativeMcpStore,secrets:oauth.secrets});
    try {
      assert.equal((await reopenedOAuth.authorization(oauthServer.server.id)).Authorization,`Bearer ${opaqueToken}`);
      assert.equal((await reopenedOAuth.authorization(oauthServer.server.id,{forceRefresh:true})).Authorization,`Bearer ${refreshedToken}`);
      assert.equal((await f.rest("mcp/verify",{id:oauthServer.server.id})).server.status,"ready");
      assert.equal(fs.readFileSync(f.paths.encryptedSecretsPath,"utf8").includes(refreshedToken),false);
    }finally{await reopenedOAuth.close();}
    oauth.fetch=upstreamFetch;
    snapshot=await f.rest("mcp/list"); await f.rest("mcp/remove",{id:oauthServer.server.id,expectedRevision:snapshot.revision});
    f.provider.state.accessToken=CANARY; f.provider.state.token=CANARY; f.provider.state.refreshAccessToken=undefined;
    snapshot=await f.rest("mcp/list");
    const denied=await f.rest("mcp/add",{source:{kind:"custom"},name:"Rejected OAuth client",option:{kind:"remote",protocol:"streamable-http",url:`${f.provider.origin}/mcp`},expectedRevision:snapshot.revision});
    let rejectedRegistrations=0;
    oauth.fetch=async(input,init)=>{
      if(new URL(input).pathname==="/register"){
        rejectedRegistrations++;
        return new Response(JSON.stringify({error:"invalid_client_metadata",error_description:CANARY}),{status:403,headers:{"content-type":"application/json"}});
      }
      return upstreamFetch(input,init);
    };
    assert.equal((await f.rest("mcp/signin",{id:denied.server.id},{status:503})).code,"MCP_OAUTH_REGISTRATION_DENIED");
    snapshot=await f.rest("mcp/list");
    assert.equal(snapshot.servers.find(server=>server.id===denied.server.id).lastCheck.errorCode,"MCP_OAUTH_REGISTRATION_DENIED");
    assert.equal(rejectedRegistrations,1);
    await f.rest("mcp/remove",{id:denied.server.id,expectedRevision:snapshot.revision});
    oauth.fetch=upstreamFetch;
    snapshot=await f.rest("mcp/list");
    const manual=await f.rest("mcp/add",{source:{kind:"custom"},name:"No dynamic registration",option:{kind:"remote",protocol:"streamable-http",url:`${f.provider.origin}/mcp`},expectedRevision:snapshot.revision});
    const registrationsBefore=f.provider.state.registrations.length;
    oauth.fetch=async(input,init)=>{
      const response=await upstreamFetch(input,init);
      if(new URL(input).pathname==="/.well-known/oauth-authorization-server"){
        const metadata=await response.json();delete metadata.registration_endpoint;
        return new Response(JSON.stringify(metadata),{headers:{"content-type":"application/json"}});
      }
      return response;
    };
    try{
      assert.equal((await f.rest("mcp/signin",{id:manual.server.id},{status:400})).code,"MCP_OAUTH_CLIENT_REQUIRED");
      snapshot=await f.rest("mcp/list");
      assert.equal(snapshot.servers.find(server=>server.id===manual.server.id).lastCheck.errorCode,"MCP_OAUTH_CLIENT_REQUIRED");
      assert.equal(f.provider.state.registrations.length,registrationsBefore);
      const recovered=await f.rest("mcp/credentials",{id:manual.server.id,fields:{headers:{Authorization:`Bearer ${CANARY}`}},expectedRevision:snapshot.revision});
      assert.equal(recovered.server.status,"ready");assert.equal(recovered.server.id,manual.server.id);
      assert.equal(f.provider.state.registrations.length,registrationsBefore);
      await f.rest("mcp/remove",{id:manual.server.id,expectedRevision:recovered.revision});
    }finally{oauth.fetch=upstreamFetch;}
    snapshot=await f.rest("mcp/list"); await f.rest("mcp/remove",{id,expectedRevision:snapshot.revision});
    console.log("PASS Service/IPC/Backend/REST: slow Registry read and real 15-second network abort, CRUD, exact DTOs, origin gate, default access, exclusions, CAS conflict, request projection, encrypted canary, real tool call, context/transcript canary, slow OAuth startup, safe registration rejection, missing-client diagnosis and token recovery, ordinary chat after failure, retirement");
  }finally{await f.close();}
}
module.exports={start,run:smoke};
if(require.main===module){
  if(process.argv.includes("--preview"))start().then(f=>{
    const info={url:`${f.url}/#/connectors`,publicUrl:`${f.provider.origin}/public`,oauthUrl:`${f.provider.origin}/mcp`,root:f.root};
    const infoPath=process.argv[process.argv.indexOf("--preview")+1];if(infoPath)fs.writeFileSync(infoPath,JSON.stringify(info),{mode:0o600});
    console.log(JSON.stringify(info));
    const stop=async()=>{await f.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);
  }).catch(error=>{console.error(error);process.exitCode=1;});
  else smoke().catch(error=>{console.error(error);process.exitCode=1;});
}
