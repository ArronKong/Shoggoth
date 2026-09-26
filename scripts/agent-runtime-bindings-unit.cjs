#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID, snapshotChecksum } = require("../app/agent-service/product-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { captureExecutionProviderRoute, assertExecutionProviderRouteCurrent } = require("../app/agent-service/execution-provider-route");
const { atomicWritePrivateFile } = require("../app/agent-service/private-file");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-bindings-v12-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root,"state"), profileRoot: path.join(root,"profile"), cacheRoot: path.join(root,"cache") });
  const open = () => new JsonlProductStore({paths, now:()=>100}).open();
  const store = open();
  fs.mkdirSync(paths.runtimeDir,{recursive:true,mode:0o700}); fs.writeFileSync(paths.lockPath,"fixture",{mode:0o600});
  const stat=fs.statSync(paths.lockPath);
  const options={paths,activeServiceLock:{dev:stat.dev,ino:stat.ino},acquireWriterLease:({lockPath})=>{
    const candidate=`${lockPath}.fixture`; fs.writeFileSync(candidate,"fixture",{mode:0o600,flag:"wx"}); fs.linkSync(candidate,lockPath); return {lockPath,release:()=>{fs.unlinkSync(lockPath);fs.unlinkSync(candidate);}};
  }};
  return {store,paths,open,options};
}
function add(store,operationId="add-pi") {
  const account=DEFAULT_RUNTIME_ACCOUNTS.find(a=>a.runtime==="pi");
  return store.addAgentRuntimeBinding(DEFAULT_AGENT_PROFILE_ID,{runtime:account.runtime,runtimeAccountId:account.id},{operationId});
}
test("one atomic authority; deterministic retry, revision CAS, immutable projections and replay",t=>{
 const f=fixture(t), profile=f.store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID), first=add(f.store);
 assert.deepEqual(add(f.store),first);
 assert.throws(()=>f.store.addAgentRuntimeBinding(profile.id,{runtime:"codex",runtimeAccountId:profile.runtimeAccountId},{operationId:"add-pi"}),{code:"AGENT_BINDING_OPERATION_CONFLICT"});
 assert.throws(()=>f.store.setAgentDefaultBinding(profile.id,first.binding.id,{revision:1}),{code:"AGENT_BINDING_REVISION_CONFLICT"});
 const changed=f.store.setAgentDefaultBinding(profile.id,first.binding.id,{revision:first.revision});
 assert.equal(f.store.getAgentProfile(profile.id).runtime,"pi");
 assert.equal(f.store.resolveAgentRuntimeProfile(profile.id,profile.defaultBindingId).runtime,"codex");
 assert.throws(()=>f.store.resolveAgentRuntimeProfile(profile.id,"missing"),{code:"AGENT_BINDING_NOT_FOUND"});
 assert.throws(()=>f.store.putAgentProfile({...f.store.getAgentProfile(profile.id),runtime:"codex"}),{code:"AGENT_BINDING_PROJECTION_READONLY"});
 assert.throws(()=>f.store.removeAgentRuntimeBinding(profile.id,first.binding.id,{revision:changed.revision}),{code:"AGENT_BINDING_DEFAULT_PROTECTED"});
 f.store.close(); const disk=JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath));
 assert.equal(disk.schemaVersion,15); assert.equal(Object.hasOwn(disk.agentProfiles[0],"runtime"),false);
 const reopened=f.open(); const {binding: _binding,...changedState}=changed; assert.deepEqual(reopened.getAgentRuntimeBindings(profile.id),changedState); reopened.close();
});
test("selected provider fence survives default change; selected account change invalidates it",t=>{
 const f=fixture(t), profile=f.store.resolveAgentRuntimeProfile(DEFAULT_AGENT_PROFILE_ID);
 const frozen=captureExecutionProviderRoute({productStore:f.store,profile});
 const added=add(f.store); f.store.setAgentDefaultBinding(profile.id,added.binding.id,{revision:added.revision});
 assert.equal(assertExecutionProviderRouteCurrent(frozen,{productStore:f.store}),true);
 const state=f.store.getAgentRuntimeBindings(profile.id);
 f.store.updateAgentRuntimeBinding(profile.id,profile.selectedBindingId,{enabled:false},{revision:state.revision});
 assert.throws(()=>assertExecutionProviderRouteCurrent(frozen,{productStore:f.store}),{code:"EXECUTION_CONTRACT_STALE"}); f.store.close();
});
