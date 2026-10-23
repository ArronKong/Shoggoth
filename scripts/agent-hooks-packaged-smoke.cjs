"use strict";
// ASAR + unpacked-worker proof with actual Electron. By default this constructs
// a focused ASAR; SHOGGOTH_HOOKS_PACKAGED_APP verifies an existing full App.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { createPackageWithOptions, extractFile } = require("@electron/asar");
const yaml = require("js-yaml");
const repoRoot = path.resolve(__dirname, "..");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const packagedApp = process.env.SHOGGOTH_HOOKS_PACKAGED_APP;
if (packagedApp !== undefined && (!path.isAbsolute(packagedApp) || packagedApp.includes("\0"))) {
  throw new TypeError("SHOGGOTH_HOOKS_PACKAGED_APP requires one absolute App path");
}
test("actual " + (packagedApp ? "packaged Shoggoth" : "Electron") + " loads Hook SQLite from ASAR and executes physical unpacked Workers", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-hooks-asar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "input"), directory = path.join(source, "app", "agent-service");
  const unpack = yaml.load(fs.readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8")).asarUnpack;
  const workers = ["hook-worker.js", "hook-worker.py", "hook-supervisor.js"];
  for (const file of workers) assert.ok(unpack.includes("app/agent-service/" + file), "production packaging must unpack " + file);
  const archive = packagedApp ? path.join(packagedApp, "Contents/Resources/app.asar") : path.join(root, "app.asar");
  if (packagedApp) assert.ok(fs.statSync(archive).isFile());
  else {
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.cpSync(path.join(repoRoot, "app", "agent-service"), directory, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(source, "package.json"));
    fs.mkdirSync(path.join(root, "pi"));
    fs.copyFileSync(path.join(repoRoot, "resources/pi/shoggoth-pi-extension.mjs"), path.join(root, "pi/shoggoth-pi-extension.mjs"));
    await createPackageWithOptions(source, archive, { unpack: "{" + workers.map(file => path.join(directory, file)).join(",") + "}" });
  }
  for (const file of ["hook-store.js", "hook-process-host.js", ...workers]) {
    const relative = "app/agent-service/" + file;
    assert.equal(hash(extractFile(archive, relative)), hash(fs.readFileSync(path.join(repoRoot, relative))));
    if (workers.includes(file)) assert.equal(hash(fs.readFileSync(path.join(archive.replace(/\.asar$/, ".asar.unpacked"), relative))), hash(fs.readFileSync(path.join(repoRoot, relative))));
  }
  const runner = path.join(root, "runner.cjs");
  fs.writeFileSync(runner, `"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const archive=process.argv[2],root=process.argv[3];
const load=name=>require(path.join(archive,"app","agent-service",name));
const {resolveServicePaths}=load("paths.js"),{HookStore}=load("hook-store.js"),{HookProcessHost}=load("hook-process-host.js"),{validateDefinition,digest}=load("hook-contract.js");
(async()=>{
 assert.ok(process.versions.electron,"must run actual Electron");
 const {piNativeHookCapabilities,PI_BUILTIN_TOOLS}=load("pi-hook-contract.js");
 const piExtension=path.join(path.dirname(archive),"pi/shoggoth-pi-extension.mjs");
 const piHost={state:"ready",cliVersion:[0,84,4],extensionPath:piExtension};
 const piProof=piNativeHookCapabilities(piHost);assert.equal(piProof.runtime_builtin?.guard.status,"supported","packaged Pi extension must match the immutable ASAR integrity manifest");
 assert.deepEqual(piProof.runtime_builtin.guard.toolNames,PI_BUILTIN_TOOLS);
 const changed=path.join(root,"changed-pi-extension.mjs");fs.mkdirSync(root,{recursive:true});fs.writeFileSync(changed,fs.readFileSync(piExtension,"utf8")+"\\n// changed");
 assert.deepEqual(piNativeHookCapabilities({...piHost,extensionPath:changed}),{});assert.deepEqual(piNativeHookCapabilities({...piHost,cliVersion:[0,84,5]}),{});
 const paths=resolveServicePaths({trustedRoot:root,stateRoot:path.join(root,"state"),profileRoot:path.join(root,"profile"),cacheRoot:path.join(root,"cache")});
 const workspace=paths.defaultWorkspaceDir;fs.mkdirSync(workspace,{recursive:true,mode:0o700});
 const store=new HookStore({paths}).open(),host=new HookProcessHost({store,cacheDir:paths.hookEphemeralDir});
 const launched=[],launch=host.launch.bind(host);host.launch=(interpreter,args,...rest)=>{launched.push(args);return launch(interpreter,args,...rest)};
 try {
  assert.equal(await host.verify(),true);
  const scope={workspace:"current",sources:["chat"]},matcher={toolScopes:["product"],toolNames:["fixture_tool"]};
  const copy=validateDefinition({schemaVersion:1,name:"包内复制",event:"tool.after",kind:"action",scope,matcher,handler:{type:"builtin",name:"workspace.copy",config:{from:"receipt.txt",to:"archive/receipt.txt"}}},workspace);
  const event={schemaVersion:1,eventId:crypto.randomUUID(),event:"tool.after",profileId:"profile-one",runId:crypto.randomUUID(),operationId:null,source:"chat",bindingId:null,runtimeSessionRef:null,runtimeTurnRef:null,toolCallId:null,tool:{scope:"product",name:"fixture_tool"},workspace,payload:{},causation:{parentEventId:null,depth:0}};
  fs.mkdirSync(path.join(workspace,"archive"));fs.writeFileSync(path.join(workspace,"receipt.txt"),"packaged receipt");
  assert.equal((await host.run(copy,event)).status,"completed");assert.equal(fs.readFileSync(path.join(workspace,"archive/receipt.txt"),"utf8"),"packaged receipt");
  await assert.rejects(host.run(copy,event));
  const script=validateDefinition({schemaVersion:1,name:"包内脚本",event:"tool.before",kind:"guard",scope,matcher,handler:{type:"script",language:"javascript",source:"module.exports=()=>({decision:'block',reason:'packaged proof'})"}},workspace);
  store.register("profile-one",crypto.randomUUID(),script);
  assert.equal((await host.run(script,{...event,event:"tool.before"})).decision,"block");
  const slow=validateDefinition({...script,scope,timeoutMs:50,handler:{type:"script",language:"javascript",source:"module.exports=()=>{while(true){}}"}},workspace);
  store.register("profile-one",crypto.randomUUID(),slow);await assert.rejects(host.run(slow,{...event,event:"tool.before"}),{code:"HOOK_TIMEOUT"});
  assert.equal(host.children.size,0);assert.ok(launched.some(args=>args[0]===path.join(archive.replace(/\\.asar$/,".asar.unpacked"),"app/agent-service/hook-worker.js")));
  store.close();store.open();assert.equal(store.list("profile-one").items.length,2);
  process.stdout.write(JSON.stringify({verified:true,electron:process.versions.electron,node:process.versions.node,sqlite:"node:sqlite",workerSourceDigest:digest(script.handler.source),piExtensionProof:"ASAR integrity manifest matches; changed source/version rejected; no CLI turn",scope:${JSON.stringify(packagedApp ? "full packaged App; installation pending" : "focused ASAR; full App and installation pending")}})+"\\n");
 } finally {await host.close();store.close();}
})().catch(error=>{console.error((error.code||"HOOK_PACKAGED_PROOF_FAILED")+": "+String(error.message).slice(0,512));process.exitCode=1});
`, { mode: 0o600 });
  const electron = fs.realpathSync(packagedApp ? path.join(packagedApp, "Contents/MacOS/Shoggoth") : require("electron"));
  const result = await promisify(execFile)(electron, [runner, archive, path.join(root, "fixture")], {
    cwd: root, env: { ELECTRON_RUN_AS_NODE: "1", HOME: root, PATH: process.env.PATH, TMPDIR: root },
    timeout: 30000, maxBuffer: 16384,
  });
  const evidence = JSON.parse(result.stdout.trim()); assert.equal(evidence.verified, true);
  t.diagnostic(JSON.stringify(evidence));
});
