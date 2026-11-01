#!/usr/bin/env node
"use strict";
// Actual group scheduler -> native GroupRun -> helper Runtime binding -> real
// Service product tool: setup requests direct the user to private chat, with no
// group card, credential form, request ledger entry, or claimed session scope.
const assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const {startInspirationFixture}=require("./fixtures/inspiration-service-fixture.cjs");
const {startFixture,CANARY}=require("./fixtures/mcp-connector-http-fixture.cjs");
const {until}=require("./mcp-connector-agent-lanes-e2e.cjs");
const {authenticateMcpSession,createMcpStdioHandler}=require("../app/shoggoth-mcp-helper");
const {requestService}=require("../app/agent-service/client");
const {isGroupChatRun}=require("../app/agent-service/group-chat-run");
const {connectorPublicError}=require("../app/core/connector-errors");
const uuid=()=>crypto.randomUUID(),code=value=>value?.error?.code||value?.code;
async function main(){const provider=await startFixture();let f,helper;try{
 f=await startInspirationFixture({agentCount:2,groupControlledRuntime:true,serviceOptions:{prewarmMcpAuth:false,autoSparkNotes:false,setCronTimer:()=>1,clearCronTimer(){},setProactiveTimer:()=>1,clearProactiveTimer(){}}});
 const rest=async(method,url,body)=>{const response=await fetch(f.url+url,{method,headers:body?{Origin:f.url,"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined}),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 const api="/__api/connectors/mcp/",added=await rest("POST",api+"add",{source:{kind:"custom"},name:"Group request fixture",option:{kind:"remote",protocol:"streamable-http",url:provider.origin+"/public"},fields:{headers:{"X-Api-Key":CANARY}},expectedRevision:(await rest("GET",api+"list")).revision});assert.equal(added.server.status,"ready");
 const profiles=f.service.productStore.listAgentProfiles().filter(p=>p.enabled),profile=profiles[0];
 const group=await rest("POST","/__api/group-chats",{operationId:uuid(),name:"Connector private chat boundary",purpose:"Request setup only in private chat",members:profiles.map(p=>({backendId:"shoggoth",agentId:p.agentId}))});
 await rest("POST","/__api/group-chats/messages?id="+group.group.id,{clientMessageId:uuid(),body:"Check whether MCP setup is available here.",mentions:[]});
 const turn=await until(()=>f.service.groupChatStore.runningOpportunities().find(t=>t.groupId===group.group.id),v=>v?.runId,"actual group turn"),run=f.service.workDispatcher.getRun(turn.runId);assert.equal(isGroupChatRun(run),true);assert.equal(run.profileId,profile.id);
 const context=await until(()=>f.service.workRunCoordinator.runContexts.get(run.id),v=>v?.threadId&&v?.turnId,"actual GroupRun Runtime context");
 const control=async(action,params)=>{const id=uuid(),dir=path.join(f.root,"group-control"),file=path.join(dir,id+".response.json");fs.writeFileSync(path.join(dir,id+".request.json"),JSON.stringify({id,action,threadId:context.threadId,turnId:context.turnId,params}),{mode:0o600});const response=await until(()=>{try{return JSON.parse(fs.readFileSync(file));}catch{return null;}},v=>v!==null,action);assert.equal(response.error,undefined,JSON.stringify(response));return response.result;};
 const auth=await authenticateMcpSession({paths:f.paths,runtimeProfileId:profile.runtimeProfileId,runtimeAccountId:profile.runtimeAccountId,safeStorage:{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>v.toString()}});helper=createMcpStdioHandler({paths:f.paths,runtimeProfileId:profile.runtimeProfileId,runtimeAccountId:profile.runtimeAccountId,sessionToken:auth.token,bindRuntimeCalls:true,requestService});await helper({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{elicitation:{}},clientInfo:{name:"group-request-boundary",version:"1"}}});
 let bindings=0,forms=0;const call=async(name,args)=>{const result=await helper({jsonrpc:"2.0",id:uuid(),method:"tools/call",params:{name,arguments:args}},{requestClient:async(method,params)=>{assert.equal(method,"elicitation/create");if(params._meta?.["shoggoth/runtime-call-binding"]){bindings++;return control("binding",params);}forms++;throw Error("Group setup must never display a form");}});return result.result;};
 const requestsBefore=f.service.mcpConnectorController.requests.size,requestFile=f.service.mcpConnectorController.requestsPath;assert.equal(fs.existsSync(requestFile),false);
 for(const[name,args]of[["mcp_server_request_connection",{url:provider.origin+"/public",purpose:"Connect in private chat"}],["mcp_server_request_secret",{serverId:added.server.id,field:"header:X-Api-Key",purpose:"Fill privately"}]]){
  const result=await call(name,args);assert.equal(code(result.structuredContent),"MCP_REQUEST_PRIVATE_CHAT_REQUIRED",JSON.stringify(result));assert.match(JSON.stringify(result),/请在私聊中完成/u);assert.equal(JSON.stringify(result).includes(CANARY),false);assert.equal(f.service.mcpConnectorController.requests.size,requestsBefore);assert.equal(fs.existsSync(requestFile),false);
 }
 assert.equal(bindings,2);assert.equal(forms,0);assert.equal(provider.state.calls,0);
 const foreignSession=(await f.ipc("chat.session.create",{operationId:uuid(),profileId:profiles[1].id,workspace:f.paths.defaultWorkspaceDir,createdAt:Date.now()})).session;
 const forged=await call("mcp_server_request_connection",{url:provider.origin+"/public",purpose:"Cannot claim another private session",sessionKey:foreignSession.sessionKey});assert.equal(code(forged.structuredContent),"MCP_TOOL_INVALID_ARGUMENTS");assert.equal(forms,0);assert.equal(f.service.mcpConnectorController.requests.size,requestsBefore);assert.equal(fs.existsSync(requestFile),false);

 const requestOwner=f.service.mcpProductToolController.getMcpRequestOwner;
 await assert.rejects(requestOwner({profileId:profile.id},{runId:"missing-run"}),{code:"MCP_REQUEST_ACCESS_DENIED"});await assert.rejects(requestOwner({profileId:profiles[1].id},{runId:run.id}),{code:"MCP_REQUEST_ACCESS_DENIED"});
 assert.deepEqual(connectorPublicError({code:"MCP_REQUEST_PRIVATE_CHAT_REQUIRED",message:CANARY}),{code:"MCP_REQUEST_PRIVATE_CHAT_REQUIRED",message:"请在私聊中完成连接器连接或凭据填写。"});
 const scan=dir=>{if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())scan(file);else if(entry.name==="journal.jsonl")assert.equal(fs.readFileSync(file,"utf8").includes('"type":"connectionRequest.upsert"'),false);}};scan(path.join(f.paths.stateDir,"agents"));
 assert.equal(f.service.mcpConnectorController.requests.size,requestsBefore);assert.equal(f.service.groupChatStore.listMessages({groupId:group.group.id,limit:20}).messages.some(message=>message.body.includes("mcp-request-")),false);
 await control("complete");await f.service.workRunCoordinator.waitForTerminal(run.id);
 console.log("PASS actual group scheduler + GroupRun + native helper trusted Runtime binding + Service product tools: connection and secret requests return fixed private-chat guidance; no forms/cards/ledger, missing/wrong Profile remain access-denied");
 }finally{const failures=[];for(const action of[()=>helper?.close(),()=>f?.close(),()=>provider.close()])try{await action();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,"group request fixture cleanup");}}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});module.exports={run:main};
