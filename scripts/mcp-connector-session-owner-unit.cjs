#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {OpenClawBackend}=require("../app/core/openclaw-backend");
const {HermesBackend}=require("../app/core/hermes-backend");
(async()=>{
  const openclaw=Object.create(OpenClawBackend.prototype);Object.assign(openclaw,{_ready:true,_stopGeneration:1,_ws:{},_connect:async()=>{}});
  let sessions=[{key:"agent:alice:chat-a",sessionId:"physical-a",kind:"direct"}],agents=[{id:"alice"}];
  openclaw.request=async name=>name==="agents.list"?{agents}:{sessions};
  assert.deepEqual(await openclaw.resolveMcpConnectionSession({agentId:"alice",sessionId:"physical-a"}),{sessionKey:"agent:alice:chat-a",kind:"direct",idle:false});
  assert.deepEqual(await openclaw.resolveMcpConnectionSession({agentId:"alice",sessionId:"agent:alice:chat-a"}),{sessionKey:"agent:alice:chat-a",kind:"direct",idle:false});
  sessions[0].hasActiveRun=false;
  assert.equal((await openclaw.resolveMcpConnectionSession({agentId:"alice",sessionId:"physical-a"})).idle,true);
  sessions[0].status="running";
  assert.equal((await openclaw.resolveMcpConnectionSession({agentId:"alice",sessionId:"physical-a"})).idle,false);
  delete sessions[0].status;delete sessions[0].hasActiveRun;
  assert.equal(await openclaw.resolveMcpConnectionSession({agentId:"bob",sessionId:"physical-a"}),null);
  assert.equal(await openclaw.resolveMcpConnectionSession({agentId:"alice",sessionId:"invented"}),null);
  sessions.push({...sessions[0],key:"agent:alice:duplicate"});assert.equal(await openclaw.resolveMcpConnectionSession({agentId:"alice",sessionId:"physical-a"}),null);sessions.pop();
  sessions[0].kind="group";assert.equal(await openclaw.resolveMcpConnectionSession({agentId:"alice",sessionId:"physical-a"}),null);sessions[0].kind="direct";
  sessions[0].key="agent:alice:cron:job";assert.equal(await openclaw.resolveMcpConnectionSession({agentId:"alice",sessionId:"physical-a"}),null);
  console.log("PASS OpenClaw actual directory/session identity ownership, unknown and ambiguous/group/Cron refusal");
  const hermes=Object.create(HermesBackend.prototype);Object.assign(hermes,{_sessionRowsComplete:true,_lifecycleGeneration:1,profileById:new Map([["hermes-default","default"]]),agents:[{id:"hermes-default"}],
    sessionRows:[{backendId:"hermes",agentId:"hermes-default",key:"agent:hermes-default:stored-1",sessionId:"stored-1",kind:"direct",source:"gateway"}],
    sendQueues:new Map(),gwTurns:new Map(),
    gwRuntimeByKey:new Map([["agent:hermes-default:stored-1",{profile:"default",runtimeId:"runtime-1",storedId:"stored-1",generation:1}]]),gwSockets:new Map([["default",{generation:1}]])});
  const expected={sessionKey:"agent:hermes-default:stored-1",kind:"direct",idle:true};
  for(const sessionId of["runtime-1","stored-1","agent:hermes-default:stored-1"])assert.deepEqual(await hermes.resolveMcpConnectionSession({agentId:"hermes-default",sessionId}),expected);
  hermes.sendQueues.set(expected.sessionKey,Promise.resolve());
  assert.equal((await hermes.resolveMcpConnectionSession({agentId:"hermes-default",sessionId:"runtime-1"})).idle,false);hermes.sendQueues.clear();
  hermes.gwTurns.set("runtime-1",{});
  assert.equal((await hermes.resolveMcpConnectionSession({agentId:"hermes-default",sessionId:"runtime-1"})).idle,false);hermes.gwTurns.clear();
  hermes.sessionRows[0].hasActiveRun=true;
  assert.equal((await hermes.resolveMcpConnectionSession({agentId:"hermes-default",sessionId:"runtime-1"})).idle,false);delete hermes.sessionRows[0].hasActiveRun;
  assert.equal(await hermes.resolveMcpConnectionSession({agentId:"hermes-other",sessionId:"stored-1"}),null);
  assert.equal(await hermes.resolveMcpConnectionSession({agentId:"hermes-default",sessionId:"not-in-directory"}),null);
  hermes.gwSockets.get("default").generation=2;assert.equal(await hermes.resolveMcpConnectionSession({agentId:"hermes-default",sessionId:"runtime-1"}),null);hermes.gwSockets.get("default").generation=1;
  hermes.sessionRows[0].source="cron";assert.equal(await hermes.resolveMcpConnectionSession({agentId:"hermes-default",sessionId:"runtime-1"}),null);hermes.sessionRows[0].source="gateway";
  hermes.sessionRows=[];assert.equal(await hermes.resolveMcpConnectionSession({agentId:"hermes-default",sessionId:"runtime-1"}),null);
  console.log("PASS Hermes live runtime/stored mapping requires one existing direct owned session and current generation");
})().catch(error=>{console.error(error);process.exitCode=1;});
