#!/usr/bin/env node
"use strict";
// L2 P5 matrix: actual Service/IPC/REST, native helper+trusted Runtime binding,
// actual JS/Python adapters, real pairing, UI broker and real HTTP MCP server.
// The native model and external Host execution contexts are controlled. No
// installed Host, real user configuration, provider account or paid model is used.
const assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const {spawn}=require("node:child_process"),{pathToFileURL}=require("node:url"),readline=require("node:readline");
const {AgentBackend}=require("../app/core/agent-backend");
const {startInspirationFixture}=require("./fixtures/inspiration-service-fixture.cjs");
const {startFixture,CANARY}=require("./fixtures/mcp-connector-http-fixture.cjs");
const {ensureCredential,readCredential}=require("../app/agent-service/external-host-pairing");
const {requestService}=require("../app/agent-service/client");
const {authenticateMcpSession,createMcpStdioHandler}=require("../app/shoggoth-mcp-helper");
const {PROTOCOL_VERSION}=require("../app/agent-service/server");
const {mcpConnectorSubjectId}=require("../app/core/mcp-connector-identity");
const uuid=()=>crypto.randomUUID(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,label){const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await delay(15);}throw Error("P5 timeout: "+label);}
class ControlledHost extends AgentBackend{
  constructor(id){super();this.backendId=id;this.agents=[];}
  get id(){return this.backendId;}get name(){return "Controlled "+this.id;}
  async getStatus(){return{id:this.id,name:this.name,connected:true,info:{}};}
  async listAgents(){return this.agents.map(item=>({...item}));}
  async getAgent(id){const row=this.agents.find(item=>item.id===id);if(!row)throw Error("unknown controlled Agent");return {...row};}
  addAgent(id){assert.equal(this.agents.some(item=>item.id===id),false);this.agents.push({id,name:id,enabled:true});}
  async resolveMcpConnectionSession({agentId,sessionId}){await this.getAgent(agentId);return sessionId===this.id+"-p5-session"?{sessionKey:`agent:${agentId}:p5-session`,kind:"direct"}:null;}
}
function startHermes(f){
  const child=spawn("python3",["-B",path.join(__dirname,"fixtures/mcp-hermes-host-driver.py")],{stdio:["pipe","pipe","pipe"],env:{PATH:process.env.PATH,HOME:f.root,TMPDIR:f.root}});
  const pending=new Map();let readyResolve,readyReject,stderr="";const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-3000);});
  readline.createInterface({input:child.stdout}).on("line",line=>{try{const value=JSON.parse(line);if(value.ready)return readyResolve();const record=pending.get(value.id);if(record){pending.delete(value.id);record.resolve(value.result);}}catch(error){readyReject(error);}});
  child.on("exit",code=>{const error=Error("Hermes controlled Host exited "+code+" "+stderr);readyReject(error);for(const record of pending.values())record.reject(error);pending.clear();});
  child.stdin.write(JSON.stringify({stateDir:f.paths.stateDir,runtimeDir:f.paths.runtimeDir,profile:"p5-new",sessionId:"hermes-p5-session"})+"\n");
  return{ready,async call(name,args,turn){await ready;const id=uuid();return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,name,arguments:args,turn})+"\n");});},async close(){if(child.exitCode!==null)return;child.stdin.end(JSON.stringify({close:true})+"\n");await Promise.race([new Promise(resolve=>child.once("exit",resolve)),delay(1500).then(()=>child.kill("SIGKILL"))]);}};
}
async function main(){
  const ocHost=new ControlledHost("openclaw"),hermesHost=new ControlledHost("hermes"),provider=await startFixture();let f,nativeHelper,nativeSession,hermes;
  try{
    f=await startInspirationFixture({groupControlledRuntime:true,extraBackends:[ocHost,hermesHost],serviceOptions:{prewarmMcpAuth:false,autoSparkNotes:false,setCronTimer:()=>1,clearCronTimer(){},setProactiveTimer:()=>1,clearProactiveTimer(){}}});
    const rest=async(endpoint,body)=>{const response=await fetch(f.url+"/__api/connectors/mcp/"+endpoint,body===undefined?{}:{method:"POST",headers:{Origin:f.url,"Content-Type":"application/json"},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(JSON.stringify(result).includes(CANARY),false);return result;};
    let added=await rest("add",{source:{kind:"custom"},name:"P5 lane fixture",option:{kind:"remote",protocol:"streamable-http",url:provider.origin+"/public"},fields:{headers:{"X-Api-Key":CANARY}},expectedRevision:(await rest("list")).revision});
    assert.equal(added.server.status,"ready");const serverId=added.server.id;
    const toggle=async(subject,disabled)=>{const state=await rest("list"),record=state.servers.find(item=>item.id===serverId),exclusions=new Set(record.disabledProfileIds);if(disabled)exclusions.add(subject);else exclusions.delete(subject);return rest("agents",{id:serverId,disabledProfileIds:[...exclusions],expectedRevision:state.revision});};
    const approve=async(promise,backend)=>{let settled=false;const observed=promise.finally(()=>{settled=true;});observed.catch(()=>{});let approvals=0;while(!settled){for(const item of (await rest("approvals")).items.filter(item=>item.backendId===backend)){assert.equal(item.toolName,"mcp_server_call");await rest("approval-resolve",{requestId:item.requestId,argumentDigest:item.argumentDigest,approved:true});approvals++;}await delay(10);}const result=await observed;assert.ok(approvals>0,"external write must pass actual UI broker");return result;};
    const denyCode=value=>value?.error?.code||value?.code;
    const checkSuccess=(value,label)=>{assert.equal(denyCode(value),undefined,JSON.stringify(value));assert.equal(value.result?.content?.[0]?.text,label,JSON.stringify(value));};
    const callArgs=value=>({serverId,toolName:"echo",arguments:{value}});
    // A genuinely new native Profile is created only after the connector is ready.
    const created=await f.ipc("agent.create",{operationId:uuid(),backendId:"shoggoth",name:"P5 native new Agent",defaultCwd:null,createdAt:Date.now()});
    const profile=f.service.productStore.getAgentProfile(created.profile.id),session=(await f.ipc("chat.session.create",{operationId:uuid(),profileId:profile.id,workspace:f.paths.defaultWorkspaceDir,createdAt:Date.now()})).session;
    let nativeContext;
    const control=async(action,params)=>{const id=uuid(),directory=path.join(f.root,"group-control"),responsePath=path.join(directory,id+".response.json");fs.writeFileSync(path.join(directory,id+".request.json"),JSON.stringify({id,action,threadId:nativeContext.threadId,turnId:nativeContext.turnId,params}),{mode:0o600});const response=await until(()=>{try{return JSON.parse(fs.readFileSync(responsePath,"utf8"));}catch{return null;}},value=>value!==null,action);assert.equal(response.error,undefined,JSON.stringify(response));return response.result;};
    const send=async()=>{const {run}=await f.ipc("chat.send",{operationId:uuid(),sessionKey:session.sessionKey,prompt:"Verify the MCP connector for this new Agent.",createdAt:Date.now()});nativeContext=await until(()=>f.service.workRunCoordinator.runContexts.get(run.id),value=>value?.threadId&&value?.turnId&&f.service.workDispatcher.getRun(run.id).status==="running","native running context");return run.id;};
    nativeSession=await authenticateMcpSession({paths:f.paths,runtimeProfileId:profile.runtimeProfileId,runtimeAccountId:profile.runtimeAccountId,safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()}});
    nativeHelper=createMcpStdioHandler({paths:f.paths,runtimeProfileId:profile.runtimeProfileId,runtimeAccountId:profile.runtimeAccountId,sessionToken:nativeSession.token,bindRuntimeCalls:true,requestService});
    await nativeHelper({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{elicitation:{}},clientInfo:{name:"p5-native-lane",version:"1"}}});
    const nativeCall=async(name,args)=>{const response=await nativeHelper({jsonrpc:"2.0",id:uuid(),method:"tools/call",params:{name,arguments:args}},{requestClient:async(method,params)=>{assert.equal(method,"elicitation/create");if(params._meta?.["shoggoth/runtime-call-binding"])return control("binding",params);assert.ok(params.requestedSchema?.properties?.confirm_product_action);return{action:"accept",content:{confirm_product_action:"确认执行"}};}});return response.result.structuredContent;};
    let nativeRun=await send();assert.ok((await nativeCall("mcp_server_list",{})).servers.some(item=>item.id===serverId));checkSuccess(await nativeCall("mcp_server_call",callArgs("native-first")),"native-first");
    await toggle(profile.id,true);assert.equal((await nativeCall("mcp_server_list",{})).servers.length,0);assert.equal(denyCode(await nativeCall("mcp_server_call",callArgs("must-not-send"))),"MCP_CONNECTOR_ACCESS_DENIED");
    await toggle(profile.id,false);assert.equal((await nativeCall("mcp_server_list",{})).servers.length,0);assert.equal(denyCode(await nativeCall("mcp_server_call",callArgs("same-run-must-not-send"))),"MCP_CONNECTOR_ACCESS_DENIED");
    await control("complete");await f.service.workRunCoordinator.waitForTerminal(nativeRun);nativeRun=await send();assert.equal((await nativeCall("mcp_server_list",{})).servers.length,1);checkSuccess(await nativeCall("mcp_server_call",callArgs("native-next")),"native-next");await control("complete");await f.service.workRunCoordinator.waitForTerminal(nativeRun);
    console.log("PASS P5 native: new actual Agent -> native helper -> trusted Runtime binding -> real Service -> actual MCP; off denied, same-Run enable withheld, next Run available");
    // Pair actual adapters with this disposable Service, without test authorize overrides.
    ensureCredential(f.paths,"openclaw");ensureCredential(f.paths,"hermes");ocHost.addAgent("oc-p5-new");hermesHost.addAgent("hermes-p5-new");
    const {createAdapter}=await import(pathToFileURL(path.join(__dirname,"../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter=createAdapter({instanceId:"openclaw-p5-host",credential:()=>readCredential(f.paths,"openclaw"),requestService:(method,params,options)=>requestService(f.paths,{id:uuid(),version:PROTOCOL_VERSION,method,params},options)});
    let before;const tools=new Map();adapter.register({on(name,handler){if(name==="before_tool_call")before=handler;},registerTool(factory,{name}){tools.set(name,factory);}});
    const ocCall=async(name,args,turn)=>{const ctx={agentId:"oc-p5-new",sessionId:"openclaw-p5-session",runId:turn},id=uuid();before({toolName:name,toolCallId:id},ctx);try{return(await tools.get(name)(ctx).execute(id,args)).details;}catch(error){return{code:error.code};}};
    hermes=startHermes(f);await hermes.ready;
    for(const lane of [{backend:"openclaw",agent:"oc-p5-new",call:ocCall},{backend:"hermes",agent:"hermes-p5-new",call:hermes.call}]){
      const subject=mcpConnectorSubjectId(lane.backend,lane.agent),listing=await lane.call("mcp_server_list",{},"first");
      assert.equal(denyCode(listing),undefined,JSON.stringify({lane:lane.backend,listing}));assert.equal(listing.servers?.length,1,JSON.stringify({lane:lane.backend,listing}));
      checkSuccess(await approve(lane.call("mcp_server_call",callArgs(lane.backend+"-first"),"first"),lane.backend),lane.backend+"-first");
      const dispatched=provider.state.calls;await toggle(subject,true);assert.equal((await lane.call("mcp_server_list",{},"first")).servers.length,0);assert.equal(denyCode(await lane.call("mcp_server_call",callArgs("off"),"first")),"MCP_CONNECTOR_ACCESS_DENIED");assert.equal(provider.state.calls,dispatched);
      await toggle(subject,false);assert.equal((await lane.call("mcp_server_list",{},"first")).servers.length,0);assert.equal(denyCode(await lane.call("mcp_server_call",callArgs("same-run"),"first")),"MCP_CONNECTOR_ACCESS_DENIED");
      assert.equal((await lane.call("mcp_server_list",{},"next")).servers.length,1);checkSuccess(await approve(lane.call("mcp_server_call",callArgs(lane.backend+"-next"),"next"),lane.backend),lane.backend+"-next");
      const waiting=lane.call("mcp_server_call",callArgs("revoked-pending"),"pending");await until(()=>rest("approvals"),value=>value.items.some(item=>item.backendId===lane.backend),"pending "+lane.backend);const count=provider.state.calls;await toggle(subject,true);await rest("approvals");assert.ok(["MCP_EXTERNAL_CALL_CANCELLED","MCP_CONNECTOR_ACCESS_DENIED"].includes(denyCode(await waiting)));assert.equal(provider.state.calls,count);assert.equal((await lane.call("mcp_server_list",{},"after-off")).servers.length,0);
      console.log("PASS P5 "+lane.backend+": new Host Agent -> actual adapter hook/middleware -> authenticated Service socket -> actual UI broker -> actual MCP; off/revoke denied, same-turn enable withheld, next turn available");
    }
    assert.equal(provider.state.calls,6,"exactly two successful calls per lane; rejected operations never dispatch");
  }finally{
    const failures=[];
    for(const cleanup of [()=>hermes?.close(),()=>nativeHelper?.close(),()=>nativeSession?.close?.(),()=>f?.close(),()=>provider.close()])try{await cleanup();}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,"P5 fixture cleanup failed");
  }
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={run:main,ControlledHost,startHermes,until};
