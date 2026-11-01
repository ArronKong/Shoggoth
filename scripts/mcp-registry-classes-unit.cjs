#!/usr/bin/env node
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {McpRegistryClient,parseRegistryEntry,resolveOption}=require("../app/agent-service/mcp-registry-client");
const {McpPackageLauncher}=require("../app/agent-service/mcp-package-launcher");
const dir=path.join(__dirname,"fixtures/mcp-registry/classes"),manifest=require("./fixtures/mcp-registry/classes/manifest.json");
const read=file=>JSON.parse(fs.readFileSync(path.join(dir,file),"utf8"));
test("registry numeric abort errors remain safe retryable failures without poisoning the cache",async()=>{
 for(const name of ["AbortError","TimeoutError"]){
  const failure=new DOMException("private network diagnostic",name);assert.equal(typeof failure.code,"number");
  let attempts=0;const latest=read("../io.github.github__github-mcp-server.json");
  const client=new McpRegistryClient({fetch:async()=>{
   if(++attempts===1)throw failure;
   return new Response(JSON.stringify({servers:[latest],metadata:{}}));
  }});
  await assert.rejects(client.list(),{code:"MCP_REGISTRY_UNAVAILABLE",message:"MCP_REGISTRY_UNAVAILABLE"});
  const recovered=await client.list();assert.equal(attempts,2);assert.equal(recovered.items[0].name,"GitHub");
 }
});
test("featured GitHub remains discoverable when its version history fills the first registry page",async()=>{
 const latest=read("../io.github.github__github-mcp-server.json"),name=latest.server.name;
 const history=Array.from({length:50},(_,index)=>{
  const entry=structuredClone(latest);entry.server.version=`0.0.${index}`;
  entry._meta["io.modelcontextprotocol.registry/official"].isLatest=false;return entry;
 });
 const client=new McpRegistryClient({fetch:async raw=>{
  const url=new URL(raw);assert.equal(url.searchParams.get("search"),name);
  const body=url.searchParams.get("version")==="latest"
   ?{servers:[latest],metadata:{}}
   :{servers:history,metadata:{nextCursor:`${name}:0.0.49`}};
  return {ok:true,text:async()=>JSON.stringify(body)};
 }});
 const page=await client.list({search:name});
 assert.ok(page.featured.includes(name));assert.equal(page.items.length,1);
 const item=page.items[0];assert.equal(item.registryName,name);assert.equal(item.name,"GitHub");
 assert.equal(item.version,latest.server.version);assert.equal(item.repositoryUrl,"https://github.com/github/github-mcp-server");
 assert.equal(item.options[0].transport.url,"https://api.githubcopilot.com/mcp/");
 assert.ok(item.options[0].fields.some(f=>f.name==="Authorization"&&f.secret));
});
test("recorded Registry classes have exact provenance and fork/paid claims grant no special execution path",()=>{
 for(const e of manifest.entries)assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir,e.file))).digest("hex"),e.sha256,e.file);
 const fork=manifest.entries.find(e=>e.classes.includes("fork"));assert.equal(fork.synthetic,false);assert.equal(fork.provenance.fork,true);assert.ok(fork.provenance.parent.startsWith("https://github.com/"));
 for(const file of["recorded-fork.json","recorded-paid.json"]){const item=parseRegistryEntry(read(file));assert.ok(item.options.length>0);assert.equal(Object.hasOwn(item,"trusted"),false);assert.equal(Object.hasOwn(item,"free"),false);assert.equal(item.registryName,read(file).server.name);}
 assert.match(manifest.entries.find(e=>e.classes.includes("paid")).provenance.claim,/Publisher description/u);
});
test("recorded Header values remain in private credentials and unsafe publisher Docker flags are rejected",()=>{
 const item=parseRegistryEntry(read("../io.github.github__github-mcp-server.json")),selected=item.options.find(o=>o.id==="remote:0");assert.ok(selected.fields.some(f=>f.name==="Authorization"&&f.secret));assert.equal(item.options.some(o=>o.transport.kind==="stdio-package"),false);
 const configured=resolveOption(item,"remote:0",{headers:{Authorization:"Bearer registry-class-canary"}});assert.equal(configured.headers.Authorization,"Bearer registry-class-canary");assert.equal(JSON.stringify(configured.transport).includes("canary"),false);assert.equal(JSON.stringify(configured.requiredFields).includes("canary"),false);
});
test("recorded npm/PyPI and synthetic OCI digest resolve only pinned packages without secret argv",async()=>{
 const launcher=new McpPackageLauncher({resolveRuntime:name=>`/runtime/${name}`}),types=[];
 for(const file of["recorded-npm.json","recorded-pypi.json","synthetic-oci-digest.json"]){const item=parseRegistryEntry(read(file)),option=item.options.find(o=>o.transport.kind==="stdio-package");assert.ok(option,file);types.push(option.transport.registryType);
 const fields={env:{},headers:{},arguments:{},variables:{}};for(const f of option.fields){const map={env:"env",header:"headers",argument:"arguments",variable:"variables"}[f.location];fields[map][f.name]=f.secret?"registry-package-secret-canary":f.default||"/private/tmp/fixture-workspace";}
 const resolved=resolveOption(item,option.id,fields),launch=await launcher.prepare(resolved.transport,{env:resolved.env});assert.equal(JSON.stringify(launch.args).includes("secret-canary"),false);assert.equal(launch.command.startsWith("/runtime/"),true);
 if(option.transport.registryType==="oci")assert.ok(launch.args.includes("ghcr.io/example/mcp@sha256:"+"a".repeat(64)));
 }
 assert.deepEqual(types,["npm","pypi","oci"]);
});
test("malformed, floating and secret-argument records cannot produce executable options",()=>{
 assert.throws(()=>parseRegistryEntry(read("synthetic-invalid-shape.json")),{code:"MCP_REGISTRY_RESPONSE_INVALID"});
 for(const file of["synthetic-invalid-versions.json","synthetic-secret-argv.json"])assert.deepEqual(parseRegistryEntry(read(file)).options,[]);
 const original=read("recorded-fork.json");for(const patch of[{status:"deleted"},{isLatest:false}]){const entry=structuredClone(original);Object.assign(entry._meta["io.modelcontextprotocol.registry/official"],patch);assert.equal(parseRegistryEntry(entry),null);}
});
