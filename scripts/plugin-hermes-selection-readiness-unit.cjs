"use strict";
const assert=require("node:assert/strict");
const {HermesBackend}=require("../app/core/hermes-backend");
async function main(){
 const backend=new HermesBackend({getConfig:()=>({hermesMode:"local",hermesRemotes:[]}),externalPluginSelectionService:{prepareExternalPluginSelection(){assert.fail("probe must not mint");}}});
 const key="agent:hermes-fixture:session", agentId="hermes-fixture";
 backend.profileById.set(agentId,"default");backend.dashboards.set("default",{});
 let calls=0;let mutate;
 let caps={version:1,runtime_session_id:"actual-owner",adapters:[{required_adapter_id:"shoggoth_shared_capabilities",adapter_generation:"actual-generation",instance_id:"actual-instance",agent_id:agentId}]};
 const sock={generation:1,request:async(method,params)=>{calls++;assert.equal(method,"prompt.selection.capabilities");assert.equal(params.session_id,"ui-session");mutate?.();return caps;}};
 backend._gwSocket=()=>sock;backend.gwSockets.set("default",sock);
 backend._gwEnsureRuntime=()=>assert.fail("readiness must not resume/create");
 assert.equal(await backend.getPluginSelectionReadiness({agentId,sessionKey:key}),false);assert.equal(calls,0);
 backend.gwRuntimeByKey.set(key,{profile:"default",runtimeId:"ui-session",generation:1});
 assert.equal(await backend.getPluginSelectionReadiness({agentId,sessionKey:key}),true);assert.equal(calls,1);
 assert.equal(await backend.getPluginSelectionReadiness({agentId:"neighbor",sessionKey:key}),false);assert.equal(calls,1);
 for(const bad of [{...caps,version:2},{...caps,runtime_session_id:""},{...caps,adapters:[]},{...caps,adapters:[{...caps.adapters[0],agent_id:"neighbor"}]}]){
  const old=caps;caps=bad;assert.equal(await backend.getPluginSelectionReadiness({agentId,sessionKey:key}),false);caps=old;
 }
 mutate=()=>{backend._lifecycleGeneration++;};assert.equal(await backend.getPluginSelectionReadiness({agentId,sessionKey:key}),false);mutate=null;
 backend.freshSessionTransports.set(key,"acp");assert.equal(await backend.getPluginSelectionReadiness({agentId,sessionKey:key}),false);
 await backend.stop();console.log(JSON.stringify({ok:true,groups:8,actualHostCapability:true,agentOwnerExact:true,noResumeMintUploadModel:true,staleFailsClosed:true}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
