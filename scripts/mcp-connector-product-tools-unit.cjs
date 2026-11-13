#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeFixture, authority, PROFILE_ID, OTHER_PROFILE_ID, RUN_ID, cleanupFixtures } = require("./shoggoth-mcp-product-tool-controller-unit.cjs");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { MCP_PRODUCT_TOOL_NAMES, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");
const { RESIDENT_PRODUCT_TOOLS, searchProductTools } = require("../app/agent-service/product-tool-exposure");
const { MCP_PRODUCT_TOOL_DEFINITIONS } = require("../app/agent-service/mcp-product-tool-controller");
const { RETIRED_CONNECTOR_TOOLS, MCP_CONNECTOR_TOOL_NAMES } = require("../app/agent-service/mcp-connector-tools");
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"sgh-mcp-product-"))); fs.chmodSync(root,0o700);
  const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,"state"),profileRoot:path.join(root,"profile"),cacheRoot:path.join(root,"cache")});
  fs.mkdirSync(paths.defaultWorkspaceDir,{recursive:true,mode:0o700});
  const store = new NativeMcpStore({paths}); store.open();
  const calls=[];
  const manager={async probe(){return [{name:"echo",inputSchema:{type:"object"}}];},async listTools(){return [{name:"echo",inputSchema:{type:"object"}}];},async callTool(id,name,args,options){options.assertCurrent();calls.push({id,name,args});return {content:[{type:"text",text:"ok"}]};},async closeServer(){}};
  const connector=new McpConnectorController({store,manager,paths,secrets:{async remove(){}},registry:{async list(p){return {items:[],nextCursor:null,query:p.search};}},assertSecretSafe(){}}).open();
  const add=(id,url="https://example.com/mcp")=>{store.register({expectedRevision:store.revision,server:{id,name:id,enabled:true,source:{kind:"custom"},transport:{kind:"remote",protocol:"streamable-http",url},auth:{kind:"none"},secretRef:null,setup:{requiredFields:[],configuredFields:[]},disabledProfileIds:[],status:"ready",lastCheck:null}});store.setStatus(id,"ready",{at:1,toolCount:1,errorCode:null});};
  add("echo");
  const fixture=makeFixture({nativeMcpStore:store,nativeMcpClientManager:manager,mcpConnectorController:connector,getMcpRequestOwner:(auth,scope)=>({profileId:auth.profileId,sessionKey:"session-1",transcriptSessionId:"transcript-1",runId:scope?.runId})});
  connector.captureRun({id:RUN_ID,profileId:PROFILE_ID});
  return {root,paths,store,connector,fixture,calls,manager,add,async close(){await connector.close();store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
const scope={runId:RUN_ID,assertCurrent(){}};
const caller=(n=1,extra={})=>authority({callId:`a0000000-0000-4000-8000-${String(n).padStart(12,"0")}`,confirmation:true,...extra});
test("new MCP setup tools have strict credential-free schemas and are non-resident",()=>{
  assert.equal(MCP_PRODUCT_TOOL_NAMES.length,178);
  for(const name of RETIRED_CONNECTOR_TOOLS)assert.equal(MCP_PRODUCT_TOOL_NAMES.includes(name),false);
  for(const name of MCP_CONNECTOR_TOOL_NAMES){assert.ok(MCP_PRODUCT_TOOL_NAMES.includes(name));assert.equal(RESIDENT_PRODUCT_TOOLS.has(name),false);}
  assert.ok(searchProductTools(MCP_PRODUCT_TOOL_DEFINITIONS,{query:"registry",limit:10}).tools.some(t=>t.name==="mcp_server_registry_search"));
  assert.ok(validateMcpProductToolArguments("mcp_server_registry_search",{query:"context7",cursor:null}));
  assert.ok(validateMcpProductToolArguments("mcp_server_request_connection",{url:"https://connect.composio.dev/mcp",purpose:"Read my mail"}));
  assert.equal(validateMcpProductToolArguments("mcp_server_request_connection",{url:"https://example.com/?token=secret",purpose:"test"}),false);
  assert.equal(validateMcpProductToolArguments("mcp_server_request_connection",{url:"https://example.com",registryName:"io.github.x/y",purpose:"test"}),false);
  assert.ok(validateMcpProductToolArguments("mcp_server_request_secret",{serverId:"echo",field:"header:Authorization",purpose:"Read"}));
  assert.equal(validateMcpProductToolArguments("mcp_server_request_secret",{serverId:"echo",field:"header:Authorization",purpose:"Read",value:"secret"}),false);
  for(const field of ["oauthClient:clientId","oauthClient:clientSecret","oauthClient.client_id","oauthClient:client_secret"])assert.ok(validateMcpProductToolArguments("mcp_server_request_secret",{serverId:"echo",field,purpose:"Repair OAuth"}));
  for(const field of ["oauthClient:token_endpoint_auth_method","oauthClient:redirectUri","oauthClient:access_token"])assert.equal(validateMcpProductToolArguments("mcp_server_request_secret",{serverId:"echo",field,purpose:"Invalid field"}),false);
});
test("Run freezes existing ready set, new Agent gets all defaults, revocation fences cache and dispatch",async()=>{
  const s=setup();try {
    const c=s.fixture.controller;
    assert.deepEqual((await c.handle("mcp_server_list",{},caller(1),scope)).servers.map(x=>x.id),["echo"]);
    await c.handle("mcp_server_call",{serverId:"echo",toolName:"echo",arguments:{}},caller(2),scope);assert.equal(s.calls.length,1);
    s.store.update({id:"echo",patch:{disabledProfileIds:[PROFILE_ID]},expectedRevision:s.store.revision});
    await assert.rejects(c.handle("mcp_server_call",{serverId:"echo",toolName:"echo",arguments:{}},caller(2),scope),e=>e.code==="MCP_CONNECTOR_ACCESS_DENIED");assert.equal(s.calls.length,1);
    assert.equal((await c.handle("mcp_server_list",{},caller(1),scope)).servers.length,0);
    assert.equal((await c.handle("mcp_server_list",{},caller(3,{profileId:OTHER_PROFILE_ID}))).servers.length,1,"new unrelated Agent has access without granting");
    s.add("added-later");assert.equal((await c.handle("mcp_server_list",{},caller(1),scope)).servers.length,0);
    s.connector.captureRun({id:"next",profileId:PROFILE_ID});
    assert.deepEqual((await c.handle("mcp_server_list",{},caller(4),{...scope,runId:"next"})).servers.map(x=>x.id),["added-later"]);
  }finally{await s.close();}
});
test("unbound federation cannot borrow default Profile, trusted subjects preserve per-Agent switch",async()=>{
  const s=setup();try {
    const c=s.fixture.controller;
    await assert.rejects(c.handle("mcp_server_list",{},caller(1,{federationClient:"openclaw"})),e=>e.code==="MCP_CONNECTOR_ACCESS_DENIED");
    c.resolveMcpSubject=(auth)=>({profileId:auth.federationClient?`trusted-${auth.federationClient}`:auth.profileId});
    s.store.update({id:"echo",patch:{disabledProfileIds:["trusted-openclaw"]},expectedRevision:s.store.revision});
    assert.equal((await c.handle("mcp_server_list",{},caller(2,{federationClient:"openclaw"}))).servers.length,0);
    assert.equal((await c.handle("mcp_server_list",{},caller(3,{federationClient:"hermes"}))).servers.length,1);
  }finally{await s.close();}
});
test("request card binds real session, is idempotent and expires without storing secrets; retired calls fail explicitly",async()=>{
  const s=setup();try {
    const c=s.fixture.controller;const args={registryName:"io.github.upstash/context7",purpose:"Read library documentation"};
    const first=await c.handle("mcp_server_request_connection",args,caller(1),scope);
    const second=await c.handle("mcp_server_request_connection",args,caller(2),scope);assert.deepEqual(second,first);assert.equal(first.status,"pending");
    assert.equal(first.expiresAt-first.createdAt,24*60*60*1000);assert.equal(s.connector.requests.size,1);
    for(const tool of RETIRED_CONNECTOR_TOOLS)await assert.rejects(c.handle(tool,{},caller(3)),e=>e.code==="OPEN_CONNECTOR_RETIRED");
    c.getMcpRequestOwner=()=>null;
    await assert.rejects(c.handle("mcp_server_request_connection",{url:"https://example.com/mcp",purpose:"test"},caller(4),scope),e=>e.code==="MCP_CONNECTOR_ACCESS_DENIED");
  }finally{await s.close();}
});
test("curated app requests accept only their canonical primary endpoint and preserve exact Registry matching",async()=>{
  const s=setup();try{
    const registryName="io.github.variflight/variflight-mcp";
    const preset=require("../app/agent-service/data/mcp-featured-presets.json").find(value=>value.id==="variflight");
    const owner={profileId:PROFILE_ID,sessionKey:"session-1",transcriptSessionId:"transcript-1"};
    s.add("canonical-flight",preset.url);s.add("secondary-flight",preset.endpoints[1].url);s.add("unrelated-flight","https://example.com/variflight");
    const request=await s.connector.request({registryName,purpose:"Connect the current catalog application"},owner);
    for(const serverId of ["secondary-flight","unrelated-flight"])await assert.rejects(s.connector.complete({requestId:request.requestId,serverId}),error=>error.code==="MCP_REQUEST_TARGET_MISMATCH");
    const unknown=await s.connector.request({registryName:registryName+"-lookalike",purpose:"Unknown publisher"},owner);
    await assert.rejects(s.connector.complete({requestId:unknown.requestId,serverId:"canonical-flight"}),error=>error.code==="MCP_REQUEST_TARGET_MISMATCH");
    const completed=await s.connector.complete({requestId:request.requestId,serverId:"canonical-flight"});
    assert.equal(completed.status,"completed");assert.equal(completed.serverId,"canonical-flight");assert.equal(completed.registryName,registryName);
    assert.deepEqual(await s.connector.complete({requestId:request.requestId,serverId:"canonical-flight"}),completed,"completed requests remain idempotent");
    assert.equal(s.connector.requests.get(unknown.requestId).status,"pending");
    const changed=await s.connector.request({registryName,purpose:"Do not acknowledge a target changed during verification"},owner);
    const listTools=s.manager.listTools;let replaced=false;
    s.manager.listTools=async id=>{if(id==="canonical-flight"&&!replaced){replaced=true;s.store.update({id,patch:{transport:{kind:"remote",protocol:"streamable-http",url:"https://example.com/changed"}},expectedRevision:s.store.revision});}return listTools(id);};
    await assert.rejects(s.connector.complete({requestId:changed.requestId,serverId:"canonical-flight"}),error=>error.code==="MCP_REGISTRY_REVISION_CONFLICT");
    assert.equal(s.connector.requests.get(changed.requestId).status,"pending","the existing revision fence rejects a target changed during the asynchronous probe");
  }finally{await s.close();}
});
test("approval previews keep Chinese parameters and pending inbox within wire byte bounds",async()=>{
  const {McpExternalApprovalBroker}=require("../app/agent-service/mcp-external-approval-broker");
  const broker=new McpExternalApprovalBroker();const signal=new AbortController().signal;const waiting=[];
  try{
    for(let i=0;i<8;i++)waiting.push(broker.request({identity:{backendId:"openclaw",instanceId:"host",agentId:"agent",sessionId:"session",runId:"run",toolCallId:"call-"+i},name:"mcp_server_call",arguments:{serverId:"echo",text:"中文参数".repeat(3000),password:"hidden"},reason:"审批理由".repeat(2000),assertCurrent(){},signal}).catch(error=>error.code));
    const list=broker.list();assert.equal(list.items.length,4);assert.ok(Buffer.byteLength(JSON.stringify(list))<64000);
    for(const item of list.items){assert.ok(Buffer.byteLength(item.argumentsPreview)<=8003);assert.ok(Buffer.byteLength(item.reason)<=1003);assert.equal(item.argumentsPreview.includes("�"),false);assert.equal(item.argumentsPreview.includes("hidden"),false);}
  }finally{broker.close();assert.deepEqual(await Promise.all(waiting),Array(8).fill("MCP_EXTERNAL_CALL_CANCELLED"));}
});
test("trusted external Host turns share MCP proxy with final-argument approval and no replay",async()=>{
  const {McpExternalToolService}=require("../app/agent-service/mcp-external-tool-service");
  const {McpExternalApprovalBroker}=require("../app/agent-service/mcp-external-approval-broker");
  const {mcpConnectorSubjectId}=require("../app/agent-service/mcp-connector-controller");
  const s=setup();const broker=new McpExternalApprovalBroker();let service;
  try {
    s.fixture.controller.resolveMcpSubject=(auth,scope)=>scope?.mcpSubject || (!auth.federationClient?{profileId:auth.profileId,runId:scope?.runId}:null);
    let hooksBefore=0,hooksAfter=0,hooksFailed=0;const approved=new WeakSet();
    s.fixture.controller.hookToolExecution={
      async before(input){hooksBefore++;assert.equal(input.tool.scope,"native_mcp");return {token:{},arguments:{value:"hook-final"},changed:true,requiresApproval:false};},
      assertCurrent(){},markApproved(token){approved.add(token);},failed(token){assert.ok(approved.has(token));hooksFailed++;},async after(token,result){assert.ok(approved.has(token));hooksAfter++;return result;}
    };
    const globalSkill={id:"global-skill",name:"Global",description:"Global only",version:"1.0.0",contentHash:"a".repeat(64),registryRevision:1,requiredTools:[],requiredRuntimeCapabilities:["mcp"]};
    let globalRevision=1,externalAgentEnabled=true;
    service=new McpExternalToolService({paths:s.paths,connector:s.connector,toolController:s.fixture.controller,approvalBroker:broker,
      authorize:(_paths,_backend,token)=>token==="paired",getPermissionProfile:()=>s.fixture.profiles.get(PROFILE_ID),
      getSubjects:async()=>({items:[{backendId:"openclaw",agentId:"test",enabled:externalAgentEnabled},{backendId:"hermes",agentId:"hermes-default"}],unavailableBackends:[]}),
      getNativeSkillStore:()=>({get revision(){return globalRevision;},listGlobalEnabled:()=>[globalSkill],readGlobalEnabled:()=>({name:"Global",content:"Verified global instructions"})}),hookService:{freezeRun(){},releaseRun(){}}});
    const identity={backendId:"openclaw",instanceId:"host-1",agentId:"test",sessionId:"session-1",runId:"turn-1",toolCallId:"call-1"};
    const params=(name,args,id=identity)=>({credentialToken:"paired",identity:id,name,arguments:args});
    const listed=await service.handle("mcp.external.tool",params("mcp_server_list",{}));assert.equal(listed.servers.length,1);
    const skills=await service.handle("mcp.external.tool",params("shoggoth_capability_search",{query:""},{...identity,toolCallId:"skills"}));assert.equal(skills.items[0].id,"global-skill");
    assert.equal((await service.handle("mcp.external.tool",params("shoggoth_skill_read",{skillId:"global-skill"},{...identity,toolCallId:"read-skill"}))).content,"Verified global instructions");
    globalRevision=2;await assert.rejects(service.handle("mcp.external.tool",params("shoggoth_skill_read",{skillId:"global-skill"},{...identity,toolCallId:"read-revoked"})),e=>e.code==="SKILL_NOT_ENABLED");
    const callParams=params("mcp_server_call",{serverId:"echo",toolName:"echo",arguments:{value:"initial"}},{...identity,toolCallId:"write-1"});
    const running=service.handle("mcp.external.tool",callParams);await new Promise(setImmediate);
    assert.equal(s.calls.length,0);let pending=broker.list().items[0];assert.ok(pending);
    assert.throws(()=>broker.resolve({requestId:pending.requestId,argumentDigest:"0".repeat(64),approved:true}),e=>e.code==="MCP_EXTERNAL_APPROVAL_INVALID");
    broker.resolve({requestId:pending.requestId,argumentDigest:pending.argumentDigest,approved:true});await new Promise(setImmediate);
    assert.equal(s.calls.length,0);pending=broker.list().items[0];assert.ok(pending.argumentsPreview.includes("hook-final"));
    broker.resolve({requestId:pending.requestId,argumentDigest:pending.argumentDigest,approved:true});await running;
    assert.equal(s.calls.length,1);assert.equal(s.calls[0].args.value,"hook-final");assert.equal(hooksBefore,1);assert.equal(hooksAfter,1);
    await service.handle("mcp.external.tool",callParams);assert.equal(s.calls.length,1,"same Host tool identity does not replay");
    const dispatch=s.manager.callTool;let unknownDispatches=0;s.manager.callTool=async()=>{unknownDispatches++;throw Object.assign(Error("unknown"),{code:"MCP_SERVER_RESULT_UNKNOWN"});};
    const unknownParams=params("mcp_server_call",{serverId:"echo",toolName:"echo",arguments:{}},{...identity,toolCallId:"unknown-1"});
    const unknown=assert.rejects(service.handle("mcp.external.tool",unknownParams),error=>error.code==="MCP_SERVER_RESULT_UNKNOWN");
    await new Promise(setImmediate);
    for(let i=0;i<2;i++){const approval=broker.list().items[0];assert.ok(approval);broker.resolve({requestId:approval.requestId,argumentDigest:approval.argumentDigest,approved:true});await new Promise(setImmediate);}
    await unknown;assert.equal(hooksFailed,1);assert.equal(hooksAfter,1);assert.equal(unknownDispatches,1);
    await assert.rejects(service.handle("mcp.external.tool",unknownParams),error=>error.code==="MCP_SERVER_RESULT_UNKNOWN");assert.equal(unknownDispatches,1);s.manager.callTool=dispatch;
    const removedAgent=assert.rejects(service.handle("mcp.external.tool",params("mcp_server_call",{serverId:"echo",toolName:"echo",arguments:{}},{...identity,toolCallId:"agent-removed"})),error=>error.code==="MCP_EXTERNAL_AUTH_FAILED");
    await new Promise(setImmediate);externalAgentEnabled=false;const removing=broker.list().items[0];assert.ok(removing);broker.resolve({requestId:removing.requestId,argumentDigest:removing.argumentDigest,approved:true});await removedAgent;externalAgentEnabled=true;assert.equal(s.calls.length,1);
    const denied=service.handle("mcp.external.tool",params("mcp_server_call",{serverId:"echo",toolName:"echo",arguments:{}},{...identity,toolCallId:"write-2"}));
    const refusal=assert.rejects(denied,e=>e.code==="MCP_CONNECTOR_ACCESS_DENIED"||e.code==="MCP_EXTERNAL_CALL_CANCELLED");await new Promise(setImmediate);
    s.store.update({id:"echo",patch:{disabledProfileIds:[mcpConnectorSubjectId("openclaw","test")]},expectedRevision:s.store.revision});
    assert.equal(broker.list().items.length,0);await refusal;assert.equal(s.calls.length,1);
    await assert.rejects(service.handle("mcp.external.tool",{...callParams,confirmation:true}),e=>e.code==="MCP_EXTERNAL_REQUEST_INVALID");
    await service.handle("mcp.external.cancel",{credentialToken:"paired",identity});
    await assert.rejects(service.handle("mcp.external.tool",params("mcp_server_list",{},{...identity,toolCallId:"after-cancel"})),e=>e.code==="MCP_EXTERNAL_CALL_CANCELLED");
    const hermes={backendId:"hermes",instanceId:"host-2",agentId:"hermes-default",sessionId:"hs",taskId:"task",turnId:"turn",toolCallId:"list"};
    assert.equal((await service.handle("mcp.external.tool",params("mcp_server_list",{},hermes))).servers.length,1);
    for(let i=service.calls.size;i<4096;i++)service.calls.set("capacity-"+i,{settled:true});
    await assert.rejects(service.handle("mcp.external.tool",params("mcp_server_list",{},{...hermes,toolCallId:"over-capacity"})),error=>error.code==="MCP_EXTERNAL_CAPACITY");
    assert.equal(service.calls.size,4096);assert.equal((await service.handle("mcp.external.tool",params("mcp_server_list",{},hermes))).servers.length,1,"capacity never evicts a prior dispatch identity");
  }finally{service?.close();await s.close();}
});
(async()=>{let failed=0;try{for(const [name,fn]of tests){try{await fn();console.log(`PASS ${name}`);}catch(error){failed++;console.error(`FAIL ${name}`,error);}}}finally{cleanupFixtures();}if(failed)process.exitCode=1;})();
