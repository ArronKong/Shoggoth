#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path"), crypto=require("node:crypto");
const { createContext, repoRoot }=require("./fixtures/codex-security-native-factory-context.cjs");
const native=require("../app/agent-service/plugin-codex-security-native-component");
const { previewPluginDirectory, readPluginMcpServer }=require("../app/agent-service/plugin-package-parser");
const { componentId }=require("../app/agent-service/plugin-component-catalog");
const { validatePluginManagementResult }=require("../app/core/plugin-management-dto");
const hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const sources=["app/agent-service/plugin-package-parser.js","app/agent-service/plugin-package-installer.js",
 "app/agent-service/plugin-component-resolver.js","app/agent-service/plugin-codex-security-native-component.js",
 "app/core/plugin-management-dto.js","app/core/bundled-plugin-catalog.js","app/core/plugin-codex-security-status-dto.js",
 "app/agent-service/codex-security-service-controller.js","scripts/codex-security-native-install-unit.cjs"];
const hashes=()=>Object.fromEntries(sources.map(file=>[file,hash(fs.readFileSync(path.join(repoRoot,file)))]));
(async()=>{
 const output=process.argv[2];if(output&&fs.existsSync(output))throw new Error("Evidence path must be new");
 const before=hashes(),checks=[];let context;
 const test=async(name,action)=>{await action();checks.push({name,passed:true});console.log("PASS "+name);};
 try{
  context=createContext();
  const { installer,store,resolver,catalog,installation,paths }=context;
  const release=store.getRelease(native.SOURCE_IDENTITY,installation.releaseDigest);
  const descriptor=release.components.mcpServers[0];
  const root=fs.realpathSync(path.join(paths.pluginPackagesDir,installation.releaseDigest));
  const input={installationId:installation.installationId,releaseDigest:installation.releaseDigest,
    componentId:componentId(installation.installationId,"mcp-server",native.COMPONENT_NAME),descriptorDigest:descriptor.descriptorDigest};
  await test("actual bundled preview/stage/commit/resolver register one native component and preserve original source/Skills",()=>{
   assert.equal(release.components.skills.length,15);assert.equal(release.components.mcpServers.length,1);
   assert.equal(descriptor.type,native.TRANSPORT);
   const component=resolver.inspectMcpServer(input);
   assert.equal(component.transport,native.TRANSPORT);
   assert.equal(component.spec.originalSpec.env_vars.length,43);
   assert.equal(component.spec.originalSpec.startup_timeout_sec,120);
   assert.equal(component.spec.originalSpec.tool_timeout_sec,349200);
   assert.equal(native.readCodexSecurityNativeComponent(root).sourceClosure.originalFileCount,124);
   assert.equal(catalog.get(native.PACKAGE_ID).converted.mcp,0);
   assert.equal(catalog.list().items.find(item=>item.id===native.PACKAGE_ID).localAdapter,native.TRANSPORT);
  });
  await test("installed native candidate creates no Connection/Grant and does not start tools or scan",()=>{
   assert.deepEqual(store.getConnectionCountsForComponent(installation.installationId,input.componentId),{pending:0,verified:0,disconnected:0});
   assert(store.listGlobalBindings().every(binding=>binding.componentKind==="skill"));
   const plan=context.factory.prepare({operationId:"native-registered-still-no-egress",installationId:installation.installationId},context.lease);
   assert.throws(()=>context.factory.assertFullToolEgress(plan,context.lease),{code:"CODEX_SECURITY_NATIVE_NATIVE_TURN_AND_DISPATCH_TICKET_REQUIRED"});
   assert.equal(context.factory.originalComponentCandidate(plan,context.lease).fullPluginUsable,false);
  });
  await test("public directory/schema and any other bundled source cannot opt into dedicated native transport",()=>{
   for(const options of [{},{trustedBundled:true},{nativeSourceIdentity:native.SOURCE_IDENTITY},
    {trustedBundled:false,nativeSourceIdentity:native.SOURCE_IDENTITY},
    {trustedBundled:true,nativeSourceIdentity:"bundled:other-plugin"}]){
    const preview=previewPluginDirectory(root,options);assert.equal(preview.mcpServers.length,0);
   }
   assert.throws(()=>readPluginMcpServer(root,native.COMPONENT_NAME),{code:"PACKAGE_CHANGED"});
   const trusted=previewPluginDirectory(root,{trustedBundled:true,nativeSourceIdentity:native.SOURCE_IDENTITY});
   assert.deepEqual(trusted.mcpServers,[descriptor]);assert.equal(trusted.contentDigest,installation.releaseDigest);
  });
  await test("strict public preview accepts only fixed native name from bundled installation without leaking specs",()=>{
   const preview=installer.previewBundled(native.PACKAGE_ID);
   const value={sourceKind:"bundled",previewDigest:preview.contentDigest,expectedRevision:preview.expectedRevision,
    specVersion:preview.specVersion,name:preview.name,declaredVersion:preview.declaredVersion,installable:preview.installable,
    components:{skills:preview.skills.map(({name,description,descriptorDigest})=>({name,description,descriptorDigest})),mcpServers:preview.mcpServers},diagnostics:preview.diagnostics};
   const projected=validatePluginManagementResult("plugins.install.preview",value);
   assert.equal(projected.components.mcpServers[0].type,native.TRANSPORT);
   assert.equal(JSON.stringify(projected).includes("originalSpec"),false);
   for(const change of [value=>{value.sourceKind="directory";},value=>{value.name="another-package";},
    value=>{value.components.mcpServers[0].name="another-server";},value=>{value.components.mcpServers[0].env={};}]){
    const bad=structuredClone(value);change(bad);assert.throws(()=>validatePluginManagementResult("plugins.install.preview",bad));
   }
  });
  await test("same operation returns original receipt; disable permits inspection but cannot make it executable",()=>{
   const receipt=installer.installBundled({packageId:native.PACKAGE_ID,previewDigest:installation.releaseDigest,
    expectedRevision:0,operationId:"frozen-security-release"});
   assert.equal(receipt.installationId,installation.installationId);
   const disabled=store.setInstallationDesiredState({installationId:installation.installationId,desiredState:"disabled",expectedRevision:installation.revision});
   assert.equal(resolver.inspectMcpDependency(input).transport,native.TRANSPORT);
   assert.throws(()=>resolver.inspectMcpServer(input));
   store.setInstallationDesiredState({installationId:installation.installationId,desiredState:"enabled",expectedRevision:disabled.revision});
   assert.equal(resolver.inspectMcpServer(input).descriptorDigest,descriptor.descriptorDigest);
  });
  await test("mutated installed original launcher/assets or wrapper refuses reinspection before any egress",()=>{
   for(const relative of [native.ORIGINAL_ROOT+"/scripts/launch_codex_security_mcp",native.ORIGINAL_ROOT+"/assets/logo.png","mcp.json"]){
    const target=path.join(root,relative),bytes=fs.readFileSync(target);fs.appendFileSync(target,"\n");
    assert.throws(()=>resolver.inspectMcpDependency(input),{code:"PACKAGE_CHANGED"});fs.writeFileSync(target,bytes);
    assert.equal(resolver.inspectMcpDependency(input).transport,native.TRANSPORT);
   }
  });
  await context.close();context=null;
  const after=hashes();assert.deepEqual(after,before);
  const evidence={verified:true,scope:"actual PluginPackageInstaller/Store/Resolver; no native Host, model, authenticated account or scanner execution",
   sourceBefore:before,sourceAfter:after,sourceStable:true,checks,count:checks.length,registeredOriginalComponent:true,
   fullPluginUsable:false,rightsReview:"pending",originalConversionCountUnchanged:true,nativeHostStarts:0,toolBusinessCount:0,
   component:{sourceDigest:native.SOURCE_DIGEST,descriptorDigest:descriptor.descriptorDigest,originalFiles:124,skills:15,mcp:1,environmentSelectors:43,startupTimeoutSec:120,toolTimeoutSec:349200}};
  if(output)fs.writeFileSync(output,JSON.stringify(evidence,null,2)+"\n",{flag:"wx",mode:0o600});
  console.log("native install unit: "+checks.length+"/"+checks.length);
 }catch(error){
  if(context)await context.close();
  if(output&&!fs.existsSync(output))fs.writeFileSync(output,JSON.stringify({verified:false,checks,error:{code:error.code,message:error.message},sourceBefore:before,sourceAfter:hashes()},null,2)+"\n",{flag:"wx",mode:0o600});
  throw error;
 }
})().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});
