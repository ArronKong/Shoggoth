#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {test}=require("node:test");
const {resolveServicePaths}=require("../app/agent-service/paths");
const {ChatSessionStore}=require("../app/agent-service/chat-session-store");
const {atomicWritePrivateFile}=require("../app/agent-service/private-file");
function fixture(t,extra={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"shoggoth-chat7-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,"state"),profileRoot:path.join(root,"profile"),cacheRoot:path.join(root,"cache")});
 const bindings=[{id:"binding-a",profileId:"profile",runtime:"codex",runtimeAccountId:"account-a",enabled:true},{id:"binding-b",profileId:"profile",runtime:"pi",runtimeAccountId:"account-b",enabled:true}];
 const options={paths,now:()=>100,getProfileBinding:(_profile,id)=>bindings.find(b=>b.id===(id??"binding-a")),acquireWriterLease:()=>({release(){}}),...extra};
 const open=(overrides={})=>new ChatSessionStore({...options,...overrides}).open();
 return{paths,open,bindings,store:open()};
}
function create(store){return store.createSession({operationId:"create",profileId:"profile",workspace:null,createdAt:100});}
function bind(store,key,n){store.requestBinding(key,`bind-${n}`,100);return store.completeBinding(key,`bind-${n}`,`thread-${n}`);}
test("CAS preserves conversation, retires original runtime and persists audit outbox across restart",t=>{
 const f=fixture(t);let session=create(f.store);session=bind(f.store,session.sessionKey,1);const revision=session.revision;
 assert.throws(()=>f.store.switchRuntime(session.sessionKey,{bindingId:"binding-b",revision:1}),{code:"CHAT_SESSION_REVISION_CONFLICT"});
 const changed=f.store.switchRuntime(session.sessionKey,{bindingId:"binding-b",revision,clearModelOverride:true});
 assert.equal(changed.sessionKey,session.sessionKey);assert.equal(changed.runtimeSessionId,null);assert.equal(changed.runtimeBindingId,"binding-b");assert.equal(changed.revision,revision+1);
 assert.deepEqual(changed.retiredRuntimeSessions,[{bindingId:"binding-a",runtime:"codex",runtimeAccountId:"account-a",runtimeSessionId:"thread-1",retiredAt:100}]);
 assert.equal(f.store.getBinding(session.sessionKey),null);f.store.close();
 const reopened=f.open();assert.equal(reopened.listPendingRuntimeSwitches().length,1);
 assert.throws(()=>reopened.switchRuntime(changed.sessionKey,{bindingId:"binding-a",revision:changed.revision}),{code:"CHAT_RUNTIME_SWITCH_PENDING"});
 reopened.markRuntimeSwitchAudited(changed.sessionKey,changed.revision);assert.equal(reopened.getSession(changed.sessionKey).revision,changed.revision);assert.deepEqual(reopened.listPendingRuntimeSwitches(),[]);reopened.close();
});
test("conversation renewal passes the old 32 limit and keeps a bounded, non-discarding history",t=>{
 const f=fixture(t);let session=create(f.store);
 for(let n=0;n<32;n++){session=bind(f.store,session.sessionKey,n);session=f.store.switchRuntime(session.sessionKey,{bindingId:n%2?"binding-a":"binding-b",revision:session.revision});f.store.markRuntimeSwitchAudited(session.sessionKey,session.revision);}
 session=bind(f.store,session.sessionKey,33);assert.equal(session.retiredRuntimeSessions.length,32);
 session=f.store.switchRuntime(session.sessionKey,{bindingId:"binding-a",revision:session.revision});
 f.store.markRuntimeSwitchAudited(session.sessionKey,session.revision);session=bind(f.store,session.sessionKey,34);f.store.close();
 const target=path.join(f.paths.stateDir,"chat-sessions.json"),raw=JSON.parse(fs.readFileSync(target));
 const stored=raw.sessions[session.sessionKey];
 while(stored.retiredRuntimeSessions.length<4096)stored.retiredRuntimeSessions.push({bindingId:"binding-a",runtime:"codex",runtimeAccountId:"account-a",runtimeSessionId:`capacity-${stored.retiredRuntimeSessions.length}`,retiredAt:100});
 fs.writeFileSync(target,JSON.stringify(raw),{mode:0o600});const reopened=f.open();
 assert.throws(()=>reopened.switchRuntime(session.sessionKey,{bindingId:"binding-b",revision:session.revision}),{code:"CHAT_RUNTIME_HISTORY_CAPACITY"});
 assert.equal(reopened.getSession(session.sessionKey).runtimeSessionId,"thread-34");reopened.close();
});

test("same native session id is allowed across runtime/account namespaces and refused within one",t=>{
 const f=fixture(t), first=create(f.store);
 let second=f.store.createSession({operationId:"second",profileId:"profile",workspace:null,createdAt:100,defaultBindingId:"binding-b"});
 bind(f.store,first.sessionKey,1);f.store.requestBinding(second.sessionKey,"second-bind",100);f.store.completeBinding(second.sessionKey,"second-bind","thread-1");
 const third=f.store.createSession({operationId:"third",profileId:"profile",workspace:null,createdAt:100,defaultBindingId:"binding-a"});
 f.store.requestBinding(third.sessionKey,"third-bind",100);assert.throws(()=>f.store.completeBinding(third.sessionKey,"third-bind","thread-1"),{code:"CHAT_THREAD_ID_CONFLICT"});
 f.store.close();const reopened=f.open();assert.equal(reopened.getSession(second.sessionKey).runtimeSessionId,"thread-1");reopened.close();
});
