#!/usr/bin/env node
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {prepareMcpConnectionAckRestore,McpConnectionHost,acquireMcpConnectionAckLease,ACK_WRITER_LOCK}=require("../app/mcp-connection-host");
const {resolveServicePaths}=require("../app/agent-service/paths");
const {createAuthorityBackup,restoreAuthorityBackup,verifyAuthorityBackup}=require("../app/agent-service/authority-backup");
const name="mcp-connection-acks-v1.json";
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"mcp-ack-restore-"));fs.chmodSync(root,0o700);
 const stateDir=path.join(root,"current"),stagedStateDir=path.join(root,"staged");for(const dir of[stateDir,stagedStateDir])fs.mkdirSync(dir,{mode:0o700});
 const paths=resolveServicePaths({stateRoot:stateDir,trustedRoot:root,profileRoot:path.join(root,"profile"),cacheRoot:path.join(root,"cache")});
 const write=(dir,receipts)=>fs.writeFileSync(path.join(dir,name),JSON.stringify({schemaVersion:1,receipts}),{mode:0o600});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,paths,stateDir,stagedStateDir,write};
}
const receipt=(status,char="a")=>({fingerprint:char.repeat(64),sessionKey:"agent:a:chat",status,createdAt:100,updatedAt:200});
test("restore overlays current uncertainty over an older success and never changes live bytes",t=>{
 const f=fixture(t);f.write(f.stateDir,{"mcp-request-one":receipt("pending"),"mcp-request-two":receipt("accepted","b")});f.write(f.stagedStateDir,{"mcp-request-one":receipt("accepted"),"mcp-request-two":receipt("unknown","b"),"mcp-request-three":receipt("pending","c")});
 const before=fs.readFileSync(path.join(f.stateDir,name)),overlay=prepareMcpConnectionAckRestore({paths:f.paths,stagedStateDir:f.stagedStateDir});
 try{assert.equal(overlay.restoredCount,3);assert.equal(overlay.verifySourceUnchanged(),true);
 const restored=JSON.parse(fs.readFileSync(path.join(f.stagedStateDir,name))).receipts;assert.equal(restored["mcp-request-one"].status,"unknown");assert.equal(restored["mcp-request-two"].status,"accepted");assert.equal(restored["mcp-request-three"].status,"unknown");assert.deepEqual(fs.readFileSync(path.join(f.stateDir,name)),before);
 f.write(f.stateDir,{"mcp-request-new":receipt("unknown","d")});assert.throws(()=>overlay.verifySourceUnchanged(),{code:"MCP_CONNECTION_ACK_RESTORE_SOURCE_CHANGED"});
 }finally{overlay.release();}
 assert.equal(overlay.release(),false);
});
test("same request with different scope fails before staging mutation and releases ownership",t=>{
 const f=fixture(t);f.write(f.stateDir,{"mcp-request-one":receipt("unknown")});f.write(f.stagedStateDir,{"mcp-request-one":{...receipt("accepted"),sessionKey:"agent:b:foreign"}});const before=fs.readFileSync(path.join(f.stagedStateDir,name));
 assert.throws(()=>prepareMcpConnectionAckRestore({paths:f.paths,stagedStateDir:f.stagedStateDir}),{code:"MCP_CONNECTION_ACK_RESTORE_CONFLICT"});assert.deepEqual(fs.readFileSync(path.join(f.stagedStateDir,name)),before);
 const lease=acquireMcpConnectionAckLease({paths:f.paths});lease.release();
});
test("absent current receipt is fenced against a concurrent creation",t=>{
 const f=fixture(t);f.write(f.stagedStateDir,{"mcp-request-one":receipt("pending")});const overlay=prepareMcpConnectionAckRestore({paths:f.paths,stagedStateDir:f.stagedStateDir});
 try{assert.equal(overlay.verifySourceUnchanged(),true);f.write(f.stateDir,{"mcp-request-one":receipt("accepted")});assert.throws(()=>overlay.verifySourceUnchanged(),{code:"MCP_CONNECTION_ACK_RESTORE_SOURCE_CHANGED"});}finally{overlay.release();}
});
test("live App writer prevents backup and restore without a process kill or ledger changes",async t=>{
 const f=fixture(t);f.write(f.stateDir,{"mcp-request-one":receipt("unknown")});createAuthorityBackup({paths:f.paths,backupId:"before-app"});
 const host=new McpConnectionHost({paths:f.paths,origin:"http://127.0.0.1:1",resolveSession:async()=>({kind:"direct",sessionKey:"agent:a:chat"}),send:async()=>{}});
 try{await host.ack({backendId:"openclaw",agentId:"a",sessionId:"chat",requestId:"mcp-request-live"});const before=fs.readFileSync(path.join(f.stateDir,name));
 assert.throws(()=>createAuthorityBackup({paths:f.paths,backupId:"during-app"}),{code:"BACKUP_SERVICE_ACTIVE"});
 assert.throws(()=>restoreAuthorityBackup({paths:f.paths,backupId:"before-app",destinationStateDir:path.join(f.root,"rejected")}),{code:"BACKUP_SERVICE_ACTIVE"});
 assert.equal(fs.existsSync(path.join(f.root,"rejected")),false);assert.deepEqual(fs.readFileSync(path.join(f.stateDir,name)),before);assert.equal(process.kill(process.pid,0),true);
 }finally{await host.close();}
 const lease=acquireMcpConnectionAckLease({paths:f.paths});lease.release();
});
test("restore holds its lease through commit and App writes resume only after release",async t=>{
 const f=fixture(t),overlay=prepareMcpConnectionAckRestore({paths:f.paths,stagedStateDir:f.stagedStateDir});
 const host=new McpConnectionHost({paths:f.paths,origin:"http://127.0.0.1:1",resolveSession:async()=>({kind:"direct",sessionKey:"agent:a:chat"}),send:async()=>{}}),params={backendId:"openclaw",agentId:"a",sessionId:"chat",requestId:"mcp-request-blocked"};
 try{await assert.rejects(host.ack(params),{code:"WRITER_LEASE_HELD"});assert.equal(fs.existsSync(path.join(f.stateDir,name)),false);assert.equal(overlay.verifySourceUnchanged(),true);overlay.release();assert.equal((await host.ack(params)).status,"accepted");}finally{overlay.release();await host.close();}
});
test("authority backup excludes lease evidence and restore preserves current no-replay barriers",t=>{
 const f=fixture(t);f.write(f.stateDir,{"mcp-request-one":receipt("accepted")});createAuthorityBackup({paths:f.paths,backupId:"old-ack"});
 assert.equal(verifyAuthorityBackup({paths:f.paths,backupId:"old-ack"}).manifest.entries.some(entry=>entry.path.includes(ACK_WRITER_LOCK)),false);
 f.write(f.stateDir,{"mcp-request-one":receipt("pending"),"mcp-request-two":receipt("unknown","b")});const before=fs.readFileSync(path.join(f.stateDir,name)),destination=path.join(f.root,"restored");
 const restored=restoreAuthorityBackup({paths:f.paths,backupId:"old-ack",destinationStateDir:destination});assert.equal(restored.mcpConnectionAckRestore.restoredCount,2);
 const records=JSON.parse(fs.readFileSync(path.join(destination,name))).receipts;assert.equal(records["mcp-request-one"].status,"unknown");assert.equal(records["mcp-request-two"].status,"unknown");assert.deepEqual(fs.readFileSync(path.join(f.stateDir,name)),before);
 const lease=acquireMcpConnectionAckLease({paths:f.paths});lease.release();
});
