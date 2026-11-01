"use strict";
const crypto = require("node:crypto");
const { isExecutionTimeoutMs, executionTimeoutMs } = require("../execution-timeout");
const { serviceError } = require("./security");
const { validIdentity } = require("./external-host-identity");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function clipped(value,bytes){const buffer=Buffer.from(String(value),"utf8");if(buffer.length<=bytes)return String(value);let end=bytes;while(end>0&&(buffer[end]&0xc0)===0x80)end--;return buffer.subarray(0,end).toString("utf8")+"…";}
const fail = code => { throw serviceError(code, "MCP 操作审批已取消、过期或失效"); };
function preview(value) {
  const clean = item => Array.isArray(item) ? item.map(clean) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, entry])=>[key, /(?:password|secret|api.?key|authorization|access.?token|refresh.?token)/iu.test(key)?"[REDACTED]":clean(entry)])) : item;
  const json = JSON.stringify(clean(value), null, 2);
  return clipped(json,8000);
}
class McpExternalApprovalBroker {
  constructor({now=Date.now,generation=1,redact=preview,assertSecretSafe=()=>{},timeoutMs=null}={}) {
    this.now=now;this.generation=generation;this.redact=redact;this.assertSecretSafe=assertSecretSafe;this.timeoutMs=executionTimeoutMs(timeoutMs);if(!isExecutionTimeoutMs(this.timeoutMs))fail("MCP_EXTERNAL_APPROVAL_INVALID");this.pending=new Map();this.closed=false;
  }
  request({identity,name,arguments:args,assertCurrent,signal,reason="外部助理请求执行 MCP 工具"}) {
    if(this.closed||!validIdentity(identity)||typeof assertCurrent!=="function"||!signal||signal.aborted||this.pending.size>=128)fail("MCP_EXTERNAL_APPROVAL_UNAVAILABLE");
    assertCurrent();this.assertSecretSafe(JSON.stringify(args));
    const createdAt=this.now(),requestId=crypto.randomUUID(),argumentDigest=digest([this.generation,identity,name,args]);
    const argumentsPreview=clipped(this.redact(args),8000);reason=clipped(reason,1000);this.assertSecretSafe(argumentsPreview);this.assertSecretSafe(reason);
    const details={requestId,backendId:identity.backendId,agentId:identity.agentId,sessionId:identity.sessionId,toolName:name,serverId:args.serverId||args.id||null,
      argumentsPreview,argumentDigest,reason,createdAt,expiresAt:this.timeoutMs===null?null:createdAt+this.timeoutMs};
    return new Promise((resolve,reject)=>{
      const onAbort=()=>this._settle(requestId,false,"MCP_EXTERNAL_CALL_CANCELLED");
      const timer=this.timeoutMs===null?null:setTimeout(()=>this._settle(requestId,false,"MCP_EXTERNAL_APPROVAL_EXPIRED"),this.timeoutMs);timer?.unref?.();
      this.pending.set(requestId,{details,identity:{...identity},assertCurrent,signal,onAbort,timer,resolve,reject});
      signal.addEventListener("abort",onAbort,{once:true});if(signal.aborted)onAbort();
    });
  }
  _settle(id,approved,code=null) {
    const record=this.pending.get(id);if(!record)return false;this.pending.delete(id);clearTimeout(record.timer);record.signal.removeEventListener("abort",record.onAbort);
    if(code)record.reject(serviceError(code,"MCP 操作未获准，未执行"));else if(!approved)record.reject(serviceError("MCP_EXTERNAL_APPROVAL_DENIED","用户拒绝了本次 MCP 操作"));else record.resolve({approved:true});return true;
  }
  list() {
    for(const [id,r]of this.pending){if(r.details.expiresAt!==null&&this.now()>=r.details.expiresAt)this._settle(id,false,"MCP_EXTERNAL_APPROVAL_EXPIRED");else{try{r.assertCurrent();}catch{this._settle(id,false,"MCP_EXTERNAL_CALL_CANCELLED");}}}
    return {items:[...this.pending.values()].slice(0,4).map(r=>({...r.details})),generation:this.generation};
  }
  resolve({requestId,argumentDigest,approved}) {
    if(this.closed||typeof approved!=="boolean"||typeof requestId!=="string"||typeof argumentDigest!=="string")fail("MCP_EXTERNAL_APPROVAL_INVALID");
    const r=this.pending.get(requestId);if(!r||r.details.argumentDigest!==argumentDigest||r.details.expiresAt!==null&&this.now()>=r.details.expiresAt)fail("MCP_EXTERNAL_APPROVAL_INVALID");
    r.assertCurrent();if(r.signal.aborted)fail("MCP_EXTERNAL_CALL_CANCELLED");this._settle(requestId,approved);return {resolved:true,approved};
  }
  close(){this.closed=true;this.generation+=1;for(const id of this.pending.keys())this._settle(id,false,"MCP_EXTERNAL_CALL_CANCELLED");}
}
module.exports={McpExternalApprovalBroker};
