"use strict";
const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { authorizeAdapter } = require("./external-host-pairing");
const { validIdentity } = require("./external-host-identity");
const { mcpConnectorSubjectId } = require("./mcp-connector-controller");
const { validateMcpProductToolArguments } = require("./mcp-product-tool-controller");
const { isAppleDeviceTool, TOOL_DEFINITIONS: APPLE_DEVICE_TOOL_DEFINITIONS } = require("./apple-device-tools");
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=code=>{throw serviceError(code,"外部助理 MCP 调用身份或权限不可用");};
const hash=value=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHARED_SKILL_NAMES=new Set(["shoggoth_capability_search","shoggoth_skill_read","shoggoth_skill_file_read"]);
function validSkillArgs(name,args){
  if(!args||Object.getPrototypeOf(args)!==Object.prototype)return false;
  const fields=name==="shoggoth_capability_search"?["query","cursor","revision"]:name==="shoggoth_skill_read"?["skillId","cursor"]:["skillId","relativePath","cursor"];
  if(Object.keys(args).some(key=>!fields.includes(key))||args.cursor!==undefined&&(!Number.isSafeInteger(args.cursor)||args.cursor<0))return false;
  if(name==="shoggoth_capability_search")return typeof args.query==="string"&&Buffer.byteLength(args.query)<=512&&(args.revision===undefined||/^[a-f0-9]{64}$/u.test(args.revision));
  return typeof args.skillId==="string"&&args.skillId.length<=128&&(name!=="shoggoth_skill_file_read"||typeof args.relativePath==="string"&&Buffer.byteLength(args.relativePath)<=1024);
}
const MCP_NAMES=new Set(["mcp_server_list","mcp_server_tools","mcp_server_call","mcp_server_register","mcp_server_remove","mcp_server_registry_search","mcp_server_request_connection","mcp_server_request_secret","mcp_server_add","mcp_server_import",...APPLE_DEVICE_TOOL_DEFINITIONS.map(tool=>tool.name)]);
class McpExternalToolService {
  constructor({paths,connector,toolController,approvalBroker,getPermissionProfile,getSubjects,getNativeSkillStore=()=>null,hookService=null,authorize=authorizeAdapter,assertHostCurrent=()=>{},assertSecretSafe=()=>{},now=Date.now}={}) {
    Object.assign(this,{paths,connector,toolController,approvalBroker,getPermissionProfile,getSubjects,getNativeSkillStore,hookService,authorize,assertHostCurrent,assertSecretSafe,now});
    this.runs=new Map();this.calls=new Map();this.closedRuns=new Set();this.closed=false;
  }
  _authorize(params) {
    if(this.closed||!validIdentity(params?.identity)||!this.authorize(this.paths,params.identity.backendId,params.credentialToken))fail("MCP_EXTERNAL_AUTH_FAILED");
  }
  async handle(method,params,{signal}={}) {
    this._authorize(params);
    if(method==="mcp.external.cancel"){
      if(!exact(params,["credentialToken","identity"]))fail("MCP_EXTERNAL_REQUEST_INVALID");
      const key=this._runKey(params.identity),entry=this.runs.get(key);this.closedRuns.add(key);if(entry){entry.controller.abort();this.connector.releaseRun(key);this.hookService?.releaseRun(key);this.runs.delete(key);this.closedRuns.add(key);}return {cancelled:true};
    }
    if(method!=="mcp.external.tool"||!exact(params,["credentialToken","identity","name","arguments"])||!(MCP_NAMES.has(params.name)?validateMcpProductToolArguments(params.name,params.arguments):SHARED_SKILL_NAMES.has(params.name)&&validSkillArgs(params.name,params.arguments)))fail("MCP_EXTERNAL_REQUEST_INVALID");
    this.assertSecretSafe(JSON.stringify(params.arguments));
    const directory=await this.getSubjects();const subject=directory.items.find(item=>item.backendId===params.identity.backendId&&item.agentId===params.identity.agentId);
    if(!subject||subject.enabled===false||subject.connected===false||directory.unavailableBackends?.includes(params.identity.backendId))fail("MCP_EXTERNAL_AUTH_FAILED");
    const permissionProfile=await this.getPermissionProfile();if(!permissionProfile?.enabled)fail("MCP_EXTERNAL_AUTH_FAILED");
    const identity=params.identity,runKey=this._runKey(identity),subjectProfileId=mcpConnectorSubjectId(identity.backendId,identity.agentId);
    if(this.closedRuns.has(runKey))fail("MCP_EXTERNAL_CALL_CANCELLED");
    let entry=this.runs.get(runKey);
    if(!entry){
      // Expire stale host ownership, never an active run merely because it is old.
      for(const [key,old]of this.runs){try{this.assertHostCurrent(old.identity);}catch{old.controller.abort();this.connector.releaseRun(key);this.hookService?.releaseRun(key);this.runs.delete(key);this.closedRuns.add(key);}}
      if(this.closedRuns.size>=4096||this.runs.size>=512)fail("MCP_EXTERNAL_CAPACITY");
      const run={id:runKey,profileId:permissionProfile.id,source:"chat",sourceId:`external-${hash([identity.backendId,identity.sessionId]).slice(0,32)}`,workspace:null,status:"running",startedAt:this.now()};
      entry={run,subjectProfileId,identity:{...identity},controller:new AbortController(),createdAt:this.now(),skills:this.getNativeSkillStore()?.listGlobalEnabled()||[]};this.runs.set(runKey,entry);
      try { this.connector.captureRun({...run,profileId:subjectProfileId}); this.hookService?.freezeRun(run,permissionProfile); }
      catch(error){entry.controller.abort();this.connector.releaseRun(runKey);this.runs.delete(runKey);this.closedRuns.add(runKey);throw error;}
    }
    const currentEntry=entry;
    const combined=signal?AbortSignal.any([entry.controller.signal,signal]):entry.controller.signal;
    const assertCurrent=()=>{
      this._authorize(params);if(this.runs.get(runKey)!==currentEntry||combined.aborted)fail("MCP_EXTERNAL_CALL_CANCELLED");
      this.assertHostCurrent(identity);
      if(["mcp_server_call","mcp_server_tools"].includes(params.name))this.connector.assertAvailable(params.arguments.serverId,subjectProfileId,runKey);
      if(params.name==="mcp_server_remove")this.connector.assertAvailable(params.arguments.id,subjectProfileId,runKey);
    };
    const revalidateSubject=async()=>{
      const currentDirectory=await this.getSubjects();
      const currentSubject=currentDirectory.items.find(item=>item.backendId===identity.backendId&&item.agentId===identity.agentId);
      if(!currentSubject||currentSubject.enabled===false||currentSubject.connected===false||currentDirectory.unavailableBackends?.includes(identity.backendId))fail("MCP_EXTERNAL_AUTH_FAILED");
      assertCurrent();
    };
    assertCurrent();
    if(SHARED_SKILL_NAMES.has(params.name))return this._skill(params.name,params.arguments,entry,assertCurrent);
    const key=hash(identity),fingerprint=hash([params.name,params.arguments]),existing=this.calls.get(key);
    if(existing&&!isAppleDeviceTool(params.name)){if(existing.fingerprint!==fingerprint)fail("MCP_EXTERNAL_CALL_CONFLICT");return existing.promise;}
    // Keep every dispatched identity for this Service generation. Evicting a
    // settled result would let a repeated uncertain business call execute again.
    if(!isAppleDeviceTool(params.name)&&this.calls.size>=4096)fail("MCP_EXTERNAL_CAPACITY");
    const uuidHash=crypto.createHash("sha256").update(key).digest("hex");
    const callId=`${uuidHash.slice(0,8)}-${uuidHash.slice(8,12)}-4${uuidHash.slice(13,16)}-8${uuidHash.slice(17,20)}-${uuidHash.slice(20,32)}`;
    const scope={mcpApproveHook:async({arguments:hookArgs,reason})=>{await this.approvalBroker.request({identity,name:params.name,arguments:{...params.arguments,arguments:hookArgs},assertCurrent,signal:combined,reason});await revalidateSubject();},runId:runKey,mcpSubject:{profileId:subjectProfileId,runId:runKey},mcpRun:entry.run,mcpIdentity:{...identity},signal:combined,assertCurrent,revalidateCurrent:revalidateSubject};
    const authority={profileId:permissionProfile.id,callId,federationClient:identity.backendId};
    const execute=async()=>{
      assertCurrent();
      // MCP tools/call has no exactly-once receipt. Never let the host assert approval or retry a completed dispatch.
      if(["mcp_server_call","mcp_server_register","mcp_server_remove"].includes(params.name)){
        await this.approvalBroker.request({identity,name:params.name,arguments:params.arguments,assertCurrent,signal:combined});assertCurrent();
        await revalidateSubject();
        return this.toolController.handle(params.name,params.arguments,{...authority,confirmation:true},scope);
      }
      if(isAppleDeviceTool(params.name))await revalidateSubject();
      const result=await this.toolController.handle(params.name,params.arguments,authority,scope);
      if(isAppleDeviceTool(params.name))await revalidateSubject();return result;
    };
    // Device reads are never cached here; their controller rechecks each read
    // and keeps a durable no-replay ledger for writes across Service restarts.
    if(isAppleDeviceTool(params.name))return execute();
    const record={fingerprint,promise:null,settled:false};record.promise=execute().finally(()=>{record.settled=true;});this.calls.set(key,record);return record.promise;
  }
  _skill(name,args,entry,assertCurrent){
    const store=this.getNativeSkillStore();if(!store)fail("MCP_EXTERNAL_REQUEST_INVALID");
    const allowed=new Set([...MCP_NAMES,...SHARED_SKILL_NAMES]);
    const eligible=skill=>(skill.requiredTools||[]).every(tool=>allowed.has(tool))&&(skill.requiredRuntimeCapabilities||[]).every(capability=>capability==="mcp");
    if(name==="shoggoth_capability_search"){
      const words=args.query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
      const items=entry.skills.filter(skill=>skill.registryRevision===store.revision&&words.every(word=>`${skill.name} ${skill.description}`.toLowerCase().includes(word))).map(skill=>({kind:"skill",source:"native-skill",id:skill.id,name:skill.name,description:skill.description,eligible:eligible(skill),assessment:"not_assessed",reason:eligible(skill)?"ready":"dependency_unavailable"}));
      const revision=hash([args.query,store.revision,items]),cursor=args.cursor||0;
      if(cursor>items.length||args.revision!==undefined&&args.revision!==revision)fail("SKILL_REVISION_CHANGED");
      const result={items:items.slice(cursor,cursor+5),total:items.length,nextCursor:cursor+5<items.length?cursor+5:null,revision};assertCurrent();this.assertSecretSafe(JSON.stringify(result));return result;
    }
    const skill=entry.skills.find(skill=>skill.id===args.skillId);
    if(!skill||!eligible(skill)||skill.registryRevision!==store.revision)fail("SKILL_NOT_ENABLED");
    const input={skillId:skill.id,version:skill.version,contentHash:skill.contentHash,registryRevision:skill.registryRevision};
    const file=name==="shoggoth_skill_read"?store.readGlobalEnabled(input):store.readGlobalEnabledFile({...input,relativePath:args.relativePath});
    assertCurrent();if(store.revision!==skill.registryRevision)fail("SKILL_REVISION_CHANGED");
    const chars=Array.from(file.content),cursor=args.cursor||0;if(cursor>chars.length)fail("MCP_EXTERNAL_REQUEST_INVALID");
    const result={name:file.name,contentHash:skill.contentHash,...(args.relativePath?{relativePath:args.relativePath,fileHash:file.fileHash}:{}),content:chars.slice(cursor,cursor+4096).join(""),nextCursor:cursor+4096<chars.length?cursor+4096:null};this.assertSecretSafe(JSON.stringify(result));return result;
  }
  _runKey(identity){return `external-mcp-${hash([identity.backendId,identity.instanceId,identity.agentId,identity.sessionId,identity.runId||identity.taskId,identity.turnId||null]).slice(0,48)}`;}
  close(){this.closed=true;for(const [key,entry]of this.runs){entry.controller.abort();this.connector.releaseRun(key);this.hookService?.releaseRun(key);}this.runs.clear();this.approvalBroker.close();}
}
module.exports={McpExternalToolService,MCP_EXTERNAL_TOOL_NAMES:MCP_NAMES};
