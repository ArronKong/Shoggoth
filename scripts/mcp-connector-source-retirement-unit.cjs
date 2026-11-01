#!/usr/bin/env node
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,".."),manifest=require("./fixtures/retired-open-connector-contracts.json");
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):entry.isFile()?[path.join(dir,entry.name)]:[]);}
test("precise retirement inventory is absent and product imports never load retired modules",()=>{
 const removed=new Set(manifest.removed.map(entry=>path.resolve(root,entry.path)));assert.equal(removed.size,manifest.removed.length);assert.ok(removed.size>=61);
 for(const entry of manifest.removed){assert.match(entry.sha256,/^[a-f0-9]{64}$/u);assert.equal(fs.existsSync(path.resolve(root,entry.path)),false,entry.path);}
 const imports=[/require\s*\(\s*["']([^"']+)["']\s*\)/gu,/\bfrom\s*["']([^"']+)["']/gu,/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,/\bimport\s*["']([^"']+)["']/gu];
 for(const file of files(path.join(root,"app")).filter(file=>/\.(?:js|cjs|mjs|ts|tsx)$/u.test(file))){const source=fs.readFileSync(file,"utf8");for(const pattern of imports)for(const match of source.matchAll(pattern)){if(!match[1].startsWith("."))continue;const target=path.resolve(path.dirname(file),match[1]);for(const candidate of[target,...[".js",".cjs",".mjs",".ts",".tsx","/index.js"].map(ext=>target+ext)])assert.equal(removed.has(candidate),false,`${path.relative(root,file)} imports ${match[1]}`);}}
});
test("new adapters advertise MCP names and required legacy evidence remains read-only",()=>{
 for(const backend of["openclaw","hermes"]){const tools=require(`../resources/external-plugin-adapters/${backend}/mcp-tools.json`).tools;assert.ok(tools.some(tool=>tool.name==="mcp_server_registry_search"));assert.ok(tools.some(tool=>tool.name==="mcp_server_call"));assert.equal(tools.some(tool=>tool.name.startsWith("connector_")),false);}
 for(const retained of["app/agent-service/connector-platform-retirement.js","app/agent-service/legacy-plugin-history.js","app/agent-service/external-host-identity.js","app/agent-service/external-host-pairing.js","app/agent-service/pending-command-inbox.js"])assert.equal(fs.existsSync(path.join(root,retained)),true,retained);
 assert.equal(fs.readFileSync(path.join(root,"electron-builder.yml"),"utf8").includes(".vendor/open-connector"),false);
});

test("retired App scenario cannot launch and MCP packaged proof requires an explicit candidate",()=>{
 const retired=spawnSync(process.execPath,[path.join(root,"scripts/model-operation-recovery-app-restart-fixture.cjs"),"--scenario=connector-twelve-pages"],{encoding:"utf8"});assert.notEqual(retired.status,0);assert.match(retired.stderr,/OPEN_CONNECTOR_RETIRED/u);
 const env={...process.env};delete env.SHOGGOTH_SMOKE_DIST_DIR;
 const candidate=spawnSync(process.execPath,[path.join(root,"scripts/shoggoth-packaged-runtime-smoke.mjs"),"--require-candidate"],{env,encoding:"utf8"});assert.notEqual(candidate.status,0);assert.match(candidate.stderr,/CANDIDATE_ARTIFACT_REQUIRED/u);
 assert.equal(require("../package.json").scripts["test:mcp-connectors:app"],"node scripts/shoggoth-packaged-runtime-smoke.mjs --require-candidate");
});
