#!/usr/bin/env node
"use strict";
// Independent read-only audit: actual product modules + controlled local async
// dependencies. No Worker, Gateway, model, remote call or user credential.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const { createManagedOpenClawProductHost } = require("../app/managed-openclaw-product-host");
const { createManagedOpenClawProductAuth } = require("../app/managed-openclaw-product-auth");
const root = path.resolve(__dirname, "..");
const sources = ["app/managed-openclaw-product-host.js", "app/managed-openclaw-product-auth.js", "app/managed-openclaw-product-inputs.js", "app/managed-plugin-host-quit.js", "app/ui-entry.js", "app/core/device-auth.js", "app/managed-plugin-host-runtime.js"];
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root,file))).digest("hex")]));
const before = hashes();
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture({ candidateWait = null } = {}) {
  let mode = "managed", state = "absent", enabled = true, activations = 0;
  let enteredCandidate;
  const entering = new Promise(resolve => { enteredCandidate = resolve; });
  let closePromise = null;
  const client = { ready: Promise.resolve(),
    getStatus: () => ({ state, ownership: state === "running" ? "managed" : "absent", selectionSupported: true }),
    getEndpoint: () => state === "running" ? { url: "ws://127.0.0.1:9", token: "synthetic-not-a-user-credential" } : null,
    getExecution: () => state === "running" ? { home: "/synthetic/home" } : null,
    controller: { getCandidate: async () => { enteredCandidate(); if(candidateWait) await candidateWait;
      return { candidateId: "a".repeat(64) }; }, prepareCandidate: async () => { throw Error("unexpected copy"); },
      activateCandidate: async () => { activations++; state = "running"; return { healthVerified: true }; },
      stopOwned: async () => { state = "absent"; return { ownership: "absent" }; } },
    close: () => { if(closePromise) return closePromise; state = "closed"; return closePromise = Promise.resolve({ ownership: "absent" }); } };
  const host = createManagedOpenClawProductHost({ getMode: () => mode, setManagedMode: () => { mode = "managed"; },
    createClient: () => client, getEnabled: () => enabled, onUnavailable: async () => {}, onReady: async () => {} });
  return { host, entering, disable: () => { enabled = false; }, activations: () => activations };
}
async function run() {
  const rows=[];
  async function check(name, callback) { try { await callback(); rows.push({ name, outcome: "PASS" }); }
    catch(error) { rows.push({ name, outcome: "FAIL", error: error.message }); } }
  await check("disable during candidate wait cannot invoke activation", async()=>{
    const wait = deferred(), f = fixture({ candidateWait: wait.promise });
    f.host.prepare({ operationId: "disable-during-candidate" }); await f.entering; f.disable(); wait.resolve();
    const status = await f.host.waitForOperation("disable-during-candidate");
    assert.equal(f.activations(), 0, "activation was invoked after getEnabled became false");
    assert.equal(status.selectionSupported, false);
  });
  await check("close withdraws endpoint before its first await", async()=>{
    const f = fixture(); f.host.prepare({ operationId: "before-immediate-close" }); await f.host.waitForOperation("before-immediate-close");
    const closing = f.host.close({ operationId: "immediate-close" });
    try { assert.equal(f.host.getEndpoint(), null, "endpoint remained usable synchronously after close began");
      assert.equal(f.host.getStatus().selectionSupported, false); }
    finally { await closing; }
  });
  await check("an evicted original operation cannot schedule a second activation", async()=>{
    const f = fixture(); f.host.prepare({ operationId: "evicted-original" }); await f.host.waitForOperation("evicted-original");
    for(let i=0;i<129;i++) { const operationId=`bounded-record-${i}`; f.host.restart({ operationId }); await f.host.waitForOperation(operationId); }
    const count=f.activations();
    try { f.host.prepare({ operationId: "evicted-original" }); await f.host.waitForOperation("evicted-original"); } catch(error) {
      if(!["MANAGED_HOST_OPERATION_NOT_FOUND","MANAGED_HOST_OPERATION_EXPIRED"].includes(error.code)) throw error;
    }
    assert.equal(f.activations(), count, "bounded record eviction made the same original operation a new activation");
  });
  await check("existing managed identity must be private or rejected", async()=>{
    const temp = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-managed-auth-audit-"));
    const credentialsDir=path.join(temp,"credentials"), dataRoot=path.join(temp,"data");
    const host={ isManaged:()=>true, getEndpoint:()=>({url:"ws://127.0.0.1:9",token:"synthetic-local-only"}) };
    const legacyResolver={};
    try { const auth=createManagedOpenClawProductAuth({host,legacyResolver,credentialsDir,dataRoot});
      auth.resolveConnectAuth(); const file=path.join(credentialsDir,"device-credentials.json");
      fs.chmodSync(credentialsDir,0o755); fs.chmodSync(file,0o644);
      let rejected=false; try { auth.resolveConnectAuth(); } catch { rejected=true; }
      assert(rejected || ((fs.statSync(credentialsDir).mode&0o077)===0 && (fs.statSync(file).mode&0o077)===0),
        "managed auth reused an identity with directory 0755 and key file 0644");
    } finally { fs.rmSync(temp,{recursive:true,force:true}); }
  });
  await check("concurrent config disable and re-enable are applied in current order", async()=>{
    // Execute the actual composition function body, not a rewritten equivalent.
    // Only Electron/Registry callbacks are controlled to hold a realistic slow
    // owned exit. This is a source-function audit, not an installed-App proof.
    const text=fs.readFileSync(path.join(root,"app/ui-entry.js"),"utf8");
    const start=text.indexOf("async function applyConfigChange() {");
    const end=text.indexOf("\n// Capabilities the loopback REST plane",start);
    assert(start>=0&&end>start,"actual applyConfigChange source boundary changed");
    const wait=deferred(); let current={disabledBackends:[]}, prepareCalls=0;
    const context={ configApplyQueue:Promise.resolve(), configStore:{read:()=>current}, appliedConfig:{disabledBackends:[]}, nativeTheme:{},
      connectionFieldsChanged:(prev,next)=>({gateway:false,hermes:false,backends:JSON.stringify(prev.disabledBackends)!==JSON.stringify(next.disabledBackends)}),
      appBackendRegistry:{backends:new Map([["openclaw",{getBackendDescriptor:()=>({disconnectable:true})}]]), start:async()=>{}, keepsRunningWhenDisconnected:()=>false, notifyConnectionsChanged(){}},
      managedOpenClawProductHost:{isManaged:()=>true,suspend:()=>wait.promise,prepare:()=>{prepareCalls++;}},
      openClawEndpointGeneration:0,gatewayProxy:{invalidateOpenClawUpstream(){}},crypto,buildMenu(){},console };
    const apply=vm.runInNewContext(`(${text.slice(start,end).trim()})`,context);
    current={disabledBackends:["openclaw"]}; const disabling=apply();
    await Promise.resolve();
    current={disabledBackends:[]}; const enabling=apply(); wait.resolve(); await disabling; await enabling;
    assert.equal(prepareCalls,1,"re-enable was skipped while the original disable awaited its owned exit");
    assert.deepEqual(context.appliedConfig.disabledBackends,[],"slow disable overwrote appliedConfig with a stale disabled snapshot");
  });
  assert.deepEqual(hashes(),before,"production audit sources changed during the proof");
  const report={outcome:rows.every(row=>row.outcome==="PASS")?"PASS":"FAIL",scope:"actual product-module/unit and source-function audit",codeHashes:before,
    rows,modelCalls:0,remoteCalls:0,userCredentials:false,productModified:false};
  console.log(JSON.stringify(report,null,2)); if(report.outcome!=="PASS") process.exitCode=1;
}
run().catch(error=>{console.error(error);process.exitCode=1;});
