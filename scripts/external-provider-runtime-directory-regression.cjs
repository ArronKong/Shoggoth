#!/usr/bin/env node
"use strict";
// Exercises the current production fingerprint functions in a VM against a
// small owned, deliberately unattested tree. It never claims candidate/Host
// acceptance and never modifies an existing candidate or interpreter.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),vm=require("node:vm"),assert=require("node:assert/strict");
const {createRequire}=require("node:module");
const repo=process.env.SG_RUNTIME_DIRECTORY_REPO||path.resolve(__dirname,"..");
const file=path.join(repo,"app/agent-service/external-provider-credential-writer-worker.js"),source=fs.readFileSync(file,"utf8");
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const root=fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-runtime-directory-"));fs.chmodSync(root,0o700);
const stateDir=path.join(root,"state"),shared=path.join(stateDir,"external-plugin-host-runtimes"),runtimeDirectory=path.join(shared,"openclaw"),candidate=path.join(runtimeDirectory,"candidates","a".repeat(64)),runtimeRoot=path.join(candidate,"runtime");
for(const dir of[stateDir,shared,runtimeDirectory,path.dirname(candidate),candidate,runtimeRoot])fs.mkdirSync(dir,{mode:0o700});
for(const target of[path.join(runtimeDirectory,"active.json"),path.join(runtimeDirectory,"activation.json"),path.join(candidate,"descriptor.json")])fs.writeFileSync(target,"unattested synthetic pointer\n",{mode:0o600});
fs.writeFileSync(path.join(runtimeRoot,"entry.mjs"),"// synthetic sealed bytes\n",{mode:0o400});fs.chmodSync(runtimeRoot,0o500);
const requireSource=createRequire(file),context={process,Buffer,require(name){return name==="node:worker_threads"?{parentPort:{on(){},postMessage(){},close(){}},workerData:{stateDir,resourcesRoot:path.join(repo,"resources/external-plugin-host-patches")}}:requireSource(name);}};
vm.runInNewContext(source+"\n;globalThis.probe={fingerprint,ancestorIdentity};",context,{filename:file,timeout:10000});
const writer={runtimeRoot,interpreterPath:fs.realpathSync(process.execPath)},probe=context.probe,cases=[];
try{
  const initial=probe.fingerprint(writer),marker=path.join(stateDir,".own-marker");fs.writeFileSync(marker,"one\n",{mode:0o600});fs.writeFileSync(marker+".tmp","two\n",{mode:0o600});fs.renameSync(marker+".tmp",marker);assert.equal(probe.fingerprint(writer),initial);cases.push("owned shared-state ledger publication preserves code fingerprint");
  fs.mkdirSync(path.join(shared,".owned-other-runtime"),{mode:0o700});assert.equal(probe.fingerprint(writer),initial);cases.push("owned sibling Runtime directory preserves code fingerprint");
  fs.chmodSync(stateDir,0o750);assert.throws(()=>probe.fingerprint(writer),e=>e.code==="EXTERNAL_PROVIDER_RUNTIME_PATH_UNSAFE");fs.chmodSync(stateDir,0o700);assert.equal(probe.fingerprint(writer),initial);cases.push("ancestor permission relaxation is rejected by the actual production stamp");
  const saved=path.join(root,"original-state");fs.renameSync(stateDir,saved);fs.mkdirSync(stateDir,{mode:0o700});fs.renameSync(path.join(saved,"external-plugin-host-runtimes"),shared);assert.notEqual(probe.fingerprint(writer),initial);cases.push("same path and contents with replaced ancestor inode change the stamp and cannot match cached authority");
  const fresh=probe.fingerprint(writer),entry=path.join(runtimeRoot,"entry.mjs");fs.chmodSync(entry,0o600);fs.writeFileSync(entry,"// changed sealed code\n");fs.chmodSync(entry,0o400);assert.notEqual(probe.fingerprint(writer),fresh);cases.push("sealed Runtime file edits retain full metadata and change the code stamp");
  assert.equal(sha(fs.readFileSync(file)),sha(source));process.stdout.write(JSON.stringify({status:"PASS",groups:cases.length,cases,sourceSha256:sha(source),sourceUnchanged:true,boundary:"production stamp functions on a small unattested tree, no fixed candidate or Host proof",hostStarts:0})+"\n");
}finally{if(fs.existsSync(runtimeRoot))fs.chmodSync(runtimeRoot,0o700);fs.rmSync(root,{recursive:true,force:true});}
