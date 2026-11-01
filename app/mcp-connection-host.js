"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket } = require("ws");
const { atomicWritePrivateFile, readPrivateFile } = require("./agent-service/private-file");
const { acquirePrivateWriterLease } = require("./agent-service/private-writer-lease");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./agent-service/security");
const { mcpConnectorSubjectId } = require("./core/mcp-connector-identity");
const FIXED_CONFIRMATION = "The requested MCP connector is ready. Continue the previous task using mcp_server_tools and mcp_server_call. No credentials are included in this message.";
const error = code => serviceError(code,code);
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function brokerUrl(origin) {
  const url = new URL(origin);
  if (url.protocol !== "http:" || !["127.0.0.1","localhost"].includes(url.hostname) || url.username || url.password) throw error("MCP_CONNECTION_HOST_UNAVAILABLE");
  url.protocol="ws:";url.pathname="/__chatws";url.search="";url.hash="";return url.href;
}
function sendFixedConfirmation({ origin, owner, requestId, WebSocket: Socket = WebSocket, timeoutMs = 5000, sockets }) {
  return new Promise((resolve,reject)=>{
    let socket,done=false;
    const finish=(failure)=>{if(done)return;done=true;clearTimeout(timer);if(socket){sockets?.delete(socket);try{socket.close();}catch{}}if(failure)reject(error("MCP_CONNECTION_ACK_UNKNOWN"));else resolve();};
    const timer=setTimeout(()=>finish(true),timeoutMs);
    try { socket=new Socket(brokerUrl(origin),{origin,maxPayload:256*1024});sockets?.add(socket); }
    catch { finish(true);return; }
    socket.on("open",()=>{try{socket.send(JSON.stringify({type:"req",id:requestId,method:"chat.send",params:{sessionKey:owner.sessionKey,message:FIXED_CONFIRMATION,idempotencyKey:requestId}}));}catch{finish(true);}});
    socket.on("message",raw=>{let frame;try{if(Buffer.byteLength(raw)>64*1024)return;frame=JSON.parse(raw.toString("utf8"));}catch{return;}
      if(frame?.type!=="res"||frame.id!==requestId)return;
      finish(frame.ok!==true||["needs_verification","needs-verification","unknown"].includes(frame.payload?.status));});
    socket.on("error",()=>finish(true));socket.on("close",()=>{if(!done)finish(true);});
  });
}

function validateAckReceipts(value) {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(",")!=="receipts,schemaVersion"||value.schemaVersion!==1||!value.receipts||Object.getPrototypeOf(value.receipts)!==Object.prototype||Object.keys(value.receipts).length>1024)throw error("MCP_CONNECTION_HOST_UNAVAILABLE");
  for(const[id,r]of Object.entries(value.receipts))if(!/^mcp-request-[A-Za-z0-9-]{1,100}$/u.test(id)||!r||Object.getPrototypeOf(r)!==Object.prototype||Object.keys(r).sort().join(",")!=="createdAt,fingerprint,sessionKey,status,updatedAt"||!/^[a-f0-9]{64}$/u.test(r.fingerprint)||!["pending","accepted","unknown"].includes(r.status)||typeof r.sessionKey!=="string"||!r.sessionKey.length||r.sessionKey.length>512||/[\u0000-\u001f\u007f]/u.test(r.sessionKey)||!Number.isSafeInteger(r.createdAt)||r.createdAt<0||!Number.isSafeInteger(r.updatedAt)||r.updatedAt<r.createdAt)throw error("MCP_CONNECTION_HOST_UNAVAILABLE");
  return value.receipts;
}
function ackFileSnapshot(target) {
  const before=lstatIfExists(target);if(!before)return null;
  const bytes=readPrivateFile(target,{maxBytes:2*1024*1024}),after=fs.lstatSync(target);
  const identity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":");
  if(identity(before)!==identity(after))throw error("MCP_CONNECTION_ACK_RESTORE_SOURCE_CHANGED");
  const receipts=validateAckReceipts(JSON.parse(bytes));
  return {identity:identity(after),sha256:crypto.createHash("sha256").update(bytes).digest("hex"),receipts};
}
// Restore only into an isolated staging tree. Existing App-side reservations
// overlay an older backup so restoring Service state cannot re-enable a send.
const ACK_WRITER_LOCK = "mcp-connection-acks.writer.lock";
function acquireMcpConnectionAckLease({paths}) {
  const lease=acquirePrivateWriterLease({lockPath:path.join(paths.stateDir,ACK_WRITER_LOCK),trustedRoot:paths.trustedRoot});
  const identity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.mode,stat.uid,stat.nlink].join(":");
  const original=identity(fs.lstatSync(lease.lockPath));let released=false;
  const verify=()=>{
    if(released)throw error("MCP_CONNECTION_ACK_RESTORE_SOURCE_CHANGED");
    try{for(const target of[lease.lockPath,lease.candidatePath]){const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==2||identity(stat)!==original)throw error("MCP_CONNECTION_ACK_RESTORE_SOURCE_CHANGED");}}catch{throw error("MCP_CONNECTION_ACK_RESTORE_SOURCE_CHANGED");}
    return true;
  };
  return {verify,release(){if(released)return false;const result=lease.release();released=true;return result;}};
}
function prepareMcpConnectionAckRestore({paths,stagedStateDir}) {
  ensurePrivateDirectoryTree(stagedStateDir,paths.trustedRoot);
  if (path.resolve(paths.stateDir) === path.resolve(stagedStateDir) || lstatIfExists(paths.stateDir) && fs.realpathSync(paths.stateDir) === fs.realpathSync(stagedStateDir)) throw error("MCP_CONNECTION_ACK_RESTORE_CONFLICT");
  const sourcePath=path.join(paths.stateDir,"mcp-connection-acks-v1.json"),stagePath=path.join(stagedStateDir,"mcp-connection-acks-v1.json");
  const lease=acquireMcpConnectionAckLease({paths});let released=false;
  try {
  const source=ackFileSnapshot(sourcePath),staged=ackFileSnapshot(stagePath),merged={};
  for(const[id,receipt]of Object.entries(staged?.receipts||{}))merged[id]={...receipt,status:receipt.status==="pending"?"unknown":receipt.status};
  for(const[id,receipt]of Object.entries(source?.receipts||{})){
    const old=merged[id];if(old&&(old.fingerprint!==receipt.fingerprint||old.sessionKey!==receipt.sessionKey))throw error("MCP_CONNECTION_ACK_RESTORE_CONFLICT");
    merged[id]={...receipt,status:receipt.status==="pending"?"unknown":receipt.status};
  }
  if(Object.keys(merged).length>1024)throw error("MCP_CONNECTION_ACK_CAPACITY");
  const value={schemaVersion:1,receipts:merged};validateAckReceipts(value);
  if(source||staged){ensurePrivateDirectoryTree(stagedStateDir,paths.trustedRoot);atomicWritePrivateFile(stagePath,`${JSON.stringify(value)}\n`,{trustedRoot:paths.trustedRoot});}
  const verifySourceUnchanged=()=>{
    if(released)throw error("MCP_CONNECTION_ACK_RESTORE_SOURCE_CHANGED");
    lease.verify();
    const current=ackFileSnapshot(sourcePath);
    if(Boolean(current)!==Boolean(source)||current&&(current.identity!==source.identity||current.sha256!==source.sha256))throw error("MCP_CONNECTION_ACK_RESTORE_SOURCE_CHANGED");
    return true;
  };
  return {restoredCount:Object.keys(merged).length,verifySourceUnchanged,verify:()=>lease.verify(),release(){if(released)return false;const result=lease.release();released=true;return result;}};
  } catch(failure) { lease.release();throw failure; }
}

// The App owns this private ledger. A reservation precedes the broker boundary,
// so a lost ACK or restart can only return unknown, never resend a confirmation.
class McpConnectionHost {
  constructor({paths,origin,resolveSession,now=Date.now,send=sendFixedConfirmation,WebSocket:Socket=WebSocket}={}) {
    this.paths=paths;this.origin=origin;this.resolveSession=resolveSession;this.now=now;this.send=send;this.Socket=Socket;
    this.receipts=null;this.writerLease=null;this.inFlight=new Map();this.sockets=new Set();this.closed=false;
    this.receiptPath=path.join(paths.stateDir,"mcp-connection-acks-v1.json");
  }
  _load() {
    if(this.receipts)return;
    this.writerLease ||= acquireMcpConnectionAckLease({paths:this.paths});
    this.receipts={};if(!lstatIfExists(this.receiptPath))return;
    try{const value=JSON.parse(readPrivateFile(this.receiptPath,{maxBytes:2*1024*1024}));
      this.receipts=validateAckReceipts(value);
    }catch{this.receipts=null;throw error("MCP_CONNECTION_HOST_UNAVAILABLE");}
  }
  _persist() {this.writerLease.verify();ensurePrivateDirectoryTree(this.paths.stateDir,this.paths.trustedRoot);atomicWritePrivateFile(this.receiptPath,`${JSON.stringify({schemaVersion:1,receipts:this.receipts})}\n`,{trustedRoot:this.paths.trustedRoot});}
  async owner(params) {
    if(this.closed)throw error("MCP_CONNECTION_HOST_UNAVAILABLE");
    const session=await this.resolveSession(params);
    if(!session||session.kind!=="direct"||typeof session.sessionKey!=="string"||!session.sessionKey.startsWith(`agent:${params.agentId}:`)||session.sessionKey.length>512||/[\u0000-\u001f\u007f]/u.test(session.sessionKey))throw error("MCP_CONNECTION_OWNER_UNCONFIRMED");
    return {owner:{backendId:params.backendId,agentId:params.agentId,sessionKey:session.sessionKey,
      profileId:mcpConnectorSubjectId(params.backendId,params.agentId),transcriptSessionId:`mcp-external-${fingerprint([params.backendId,params.agentId,session.sessionKey]).slice(0,48)}`}};
  }
  async ack(params) {
    if(this.closed||!this.origin)throw error("MCP_CONNECTION_HOST_UNAVAILABLE");this._load();
    const digest=fingerprint(params),old=this.receipts[params.requestId],active=this.inFlight.get(params.requestId);
    if(old&&old.fingerprint!==digest||active&&active.fingerprint!==digest)throw error("FEDERATION_OPERATION_CONFLICT");
    if(active)return active.promise;
    if(old)return {requestId:params.requestId,status:old.status==="accepted"?"accepted":"unknown",sessionKey:old.sessionKey};
    if(Object.keys(this.receipts).length>=1024)throw error("MCP_CONNECTION_ACK_CAPACITY");
    const record={fingerprint:digest,promise:null};
    record.promise=(async()=>{
      const {owner}=await this.owner(params);if(this.closed)throw error("MCP_CONNECTION_HOST_UNAVAILABLE");
      const receipt={fingerprint:digest,sessionKey:owner.sessionKey,status:"pending",createdAt:this.now(),updatedAt:this.now()};this.receipts[params.requestId]=receipt;
      try{this._persist();}catch{receipt.status="unknown";return {requestId:params.requestId,status:"unknown",sessionKey:owner.sessionKey};}
      try{await this.send({origin:this.origin,owner,requestId:params.requestId,WebSocket:this.Socket,sockets:this.sockets});receipt.status="accepted";receipt.updatedAt=this.now();this._persist();}
      catch{receipt.status="unknown";receipt.updatedAt=this.now();try{this._persist();}catch{}}
      return {requestId:params.requestId,status:receipt.status,sessionKey:owner.sessionKey};
    })().finally(()=>this.inFlight.delete(params.requestId));this.inFlight.set(params.requestId,record);return record.promise;
  }
  async status(params) {
    if (this.closed) throw error("MCP_CONNECTION_HOST_UNAVAILABLE");
    const session = await this.resolveSession(params);
    return { idle: session?.kind === "direct" && session.sessionKey === params.sessionId && session.idle === true };
  }
  async close(){this.closed=true;for(const socket of this.sockets)try{socket.terminate();}catch{}this.sockets.clear();try{await Promise.allSettled([...this.inFlight.values()].map(r=>r.promise));}finally{this.writerLease?.release();this.writerLease=null;}}
}
module.exports={acquireMcpConnectionAckLease,ACK_WRITER_LOCK,prepareMcpConnectionAckRestore,McpConnectionHost,sendFixedMcpConfirmation:sendFixedConfirmation,MCP_CONNECTION_CONFIRMATION:FIXED_CONFIRMATION};
