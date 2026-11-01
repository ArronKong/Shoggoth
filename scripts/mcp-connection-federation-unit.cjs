#!/usr/bin/env node
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {WebSocketServer}=require("ws");
const {createFederationHostServer}=require("../app/federation-host-server");
const {FederationHostClient}=require("../app/agent-service/federation-host-client");
const {resolveServicePaths}=require("../app/agent-service/paths");
const {validateFederationParams,validateFederationResult}=require("../app/federation-host-protocol");
const {MCP_CONNECTION_CONFIRMATION}=require("../app/mcp-connection-host");
const {mcpConnectorSubjectId}=require("../app/agent-service/mcp-connector-controller");
async function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-connection-host-"));fs.chmodSync(root,0o700);
 const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,"state"),profileRoot:path.join(root,"profile"),cacheRoot:path.join(root,"cache")});
 const broker=new WebSocketServer({host:"127.0.0.1",port:0});await new Promise(resolve=>broker.once("listening",resolve));
 const origin=`http://127.0.0.1:${broker.address().port}`,calls=[];let drop=false,connected=true;
 broker.on("connection",(socket,request)=>{assert.equal(request.url,"/__chatws");assert.equal(request.headers.origin,origin);socket.on("message",raw=>{const frame=JSON.parse(raw);calls.push(frame);if(drop){socket.terminate();return;}socket.send(JSON.stringify({type:"res",id:frame.id,ok:true,payload:{runId:"confirmation-run",status:"started"}}));});});
 const backend={async getAgent(id){if(!["agent-a","agent-b"].includes(id))throw Error("private-canary");return{id,name:id};},async resolveMcpConnectionSession({agentId,sessionId}){if(sessionId==="group")return{sessionKey:`agent:${agentId}:group`,kind:"group"};return["physical",`agent:${agentId}:canonical`].includes(sessionId)?{sessionKey:`agent:${agentId}:canonical`,kind:"direct"}:null;}};
 const registry={getStatus:async()=>[{id:"openclaw",connected,info:{}}],getBackend:id=>id==="openclaw"?backend:null};
 let host=createFederationHostServer({paths,registry,mcpConnectionOrigin:origin});await host.start();
 const client=new FederationHostClient({paths});
 return{root,paths,calls,client,setDrop:value=>drop=value,setConnected:value=>connected=value,restart:async()=>{await host.stop();host=createFederationHostServer({paths,registry,mcpConnectionOrigin:origin});await host.start();},remove:async()=>{await host.stop();for(const socket of broker.clients)socket.terminate();await new Promise(resolve=>broker.close(resolve));fs.rmSync(root,{recursive:true,force:true});}};
}
test("typed connection scope rejects untrusted fields and result identity drift",()=>{
 const scope={backendId:"openclaw",agentId:"agent-a",sessionId:"physical"};
 assert.equal(validateFederationParams("mcp.connection.owner",scope),true);
 assert.equal(validateFederationParams("mcp.connection.owner",{...scope,profileId:"default-native"}),false);
 assert.equal(validateFederationParams("mcp.connection.ack",{...scope,requestId:"mcp-request-one",prompt:"secret-canary"}),false);
 assert.equal(validateFederationParams("mcp.connection.owner",{...scope,sessionId:"bad\nidentity"}),false);
 const owner={backendId:"openclaw",agentId:"agent-a",sessionKey:"agent:agent-a:canonical",profileId:mcpConnectorSubjectId("openclaw","agent-a"),transcriptSessionId:"mcp-external-stable"};
 assert.equal(validateFederationResult("mcp.connection.owner",{owner},scope),true);
 assert.equal(validateFederationResult("mcp.connection.owner",{owner:{...owner,agentId:"agent-b"}},scope),false);
 assert.equal(validateFederationResult("mcp.connection.owner",{owner:{...owner,secret:"secret-canary"}},scope),false);
});
test("real private Host RPC binds the exact Agent/session and uses the shared chat broker once",async()=>{
 const f=await fixture();try{
 const scope={backendId:"openclaw",agentId:"agent-a",sessionId:"physical"};
 const first=await f.client.request("mcp.connection.owner",scope),again=await f.client.request("mcp.connection.owner",{...scope,sessionId:first.owner.sessionKey});
 assert.deepEqual(again,first);assert.equal(first.owner.profileId,mcpConnectorSubjectId("openclaw","agent-a"));assert.equal(first.owner.sessionKey,"agent:agent-a:canonical");
 await assert.rejects(f.client.request("mcp.connection.owner",{...scope,sessionId:"unknown"}),{code:"MCP_CONNECTION_OWNER_UNCONFIRMED"});
 await assert.rejects(f.client.request("mcp.connection.owner",{...scope,sessionId:"group"}),{code:"MCP_CONNECTION_OWNER_UNCONFIRMED"});
 await assert.rejects(f.client.request("mcp.connection.owner",{...scope,agentId:"missing"}),{code:"AGENT_NOT_FOUND"});
 const input={...scope,requestId:"mcp-request-one"};const[a,b]=await Promise.all([f.client.request("mcp.connection.ack",input),f.client.request("mcp.connection.ack",input)]);
 assert.equal(a.status,"accepted");assert.deepEqual(a,b);assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0],{type:"req",id:input.requestId,method:"chat.send",params:{sessionKey:first.owner.sessionKey,message:MCP_CONNECTION_CONFIRMATION,idempotencyKey:input.requestId}});
 await f.restart();assert.equal((await f.client.request("mcp.connection.ack",input)).status,"accepted");assert.equal(f.calls.length,1,"restart cannot resend accepted confirmation");
 await assert.rejects(f.client.request("mcp.connection.ack",{...input,agentId:"agent-b"}),{code:"FEDERATION_OPERATION_CONFLICT"});assert.equal(f.calls.length,1);
 f.setConnected(false);await assert.rejects(f.client.request("mcp.connection.owner",scope),{code:"BACKEND_UNAVAILABLE"});
 }finally{await f.remove();}
});
test("lost broker ACK and a persisted pre-crash reservation never replay",async()=>{
 const f=await fixture();try{
 const input={backendId:"openclaw",agentId:"agent-a",sessionId:"physical",requestId:"mcp-request-lost"};f.setDrop(true);
 assert.equal((await f.client.request("mcp.connection.ack",input)).status,"unknown");assert.equal(f.calls.length,1);
 f.setDrop(false);assert.equal((await f.client.request("mcp.connection.ack",input)).status,"unknown");await f.restart();assert.equal((await f.client.request("mcp.connection.ack",input)).status,"unknown");assert.equal(f.calls.length,1);
 const file=path.join(f.paths.stateDir,"mcp-connection-acks-v1.json"),saved=JSON.parse(fs.readFileSync(file,"utf8")),pending={...input,requestId:"mcp-request-pending"};
 saved.receipts[pending.requestId]={fingerprint:crypto.createHash("sha256").update(JSON.stringify(pending)).digest("hex"),sessionKey:"agent:agent-a:canonical",status:"pending",createdAt:Date.now(),updatedAt:Date.now()};fs.writeFileSync(file,JSON.stringify(saved),{mode:0o600});
 await f.restart();assert.equal((await f.client.request("mcp.connection.ack",pending)).status,"unknown");assert.equal(f.calls.length,1);
 assert.equal(fs.readFileSync(file,"utf8").includes("secret-canary"),false);
 }finally{await f.remove();}
});
