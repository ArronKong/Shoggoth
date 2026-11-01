#!/usr/bin/env node
"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {MCP_PRODUCT_TOOL_DEFINITIONS}=require("../app/agent-service/mcp-product-tool-controller");
const {MCP_SHARED_SKILL_DEFINITIONS}=require("../app/agent-service/mcp-connector-tools");
const {SERVICE_PROTOCOL_VERSION}=require("../app/agent-service/service-protocol-version");
const contract={schemaVersion:1,serviceProtocolVersion:SERVICE_PROTOCOL_VERSION,sharedSkillTools:MCP_SHARED_SKILL_DEFINITIONS,tools:MCP_PRODUCT_TOOL_DEFINITIONS.filter(tool=>tool.name.startsWith("mcp_server_")),deviceTools:MCP_PRODUCT_TOOL_DEFINITIONS.filter(tool=>/^apple_(?:calendar|reminders)_/u.test(tool.name))};
if(contract.tools.length!==10)throw Error("MCP connector contract count changed");
if(contract.deviceTools.length!==12)throw Error("Apple device contract count changed");
const output=`${JSON.stringify(contract,null,2)}\n`;
for(const backend of["openclaw","hermes"]){const file=path.join(__dirname,"../resources/external-plugin-adapters",backend,"mcp-tools.json");if(process.argv.includes("--check")){if(fs.readFileSync(file,"utf8")!==output)throw Error("MCP connector contract stale");}else fs.writeFileSync(file,output);}
const py=path.join(__dirname,"../resources/external-plugin-adapters/hermes/__init__.py");
const source=fs.readFileSync(py,"utf8");
const line=`MCP_CONTRACT = json.loads(${JSON.stringify(JSON.stringify(contract))})`;
if(source.includes("MCP_CONTRACT = json.loads(")){const updated=source.replace(/^MCP_CONTRACT = json.loads\(.*\)$/mu,line);if(process.argv.includes("--check")){if(updated!==source)throw Error("Hermes MCP contract stale");}else fs.writeFileSync(py,updated);}
const oc=path.join(__dirname,"../resources/external-plugin-adapters/openclaw/index.mjs");
const ocSource=fs.readFileSync(oc,"utf8"),ocUpdated=ocSource.replace(/MCP_CONTRACT\.serviceProtocolVersion!==\d+/u,`MCP_CONTRACT.serviceProtocolVersion!==${SERVICE_PROTOCOL_VERSION}`)
  .replace(/MCP_CONTRACT\.tools\.length!==\d+/u,`MCP_CONTRACT.tools.length!==${contract.tools.length}`);
if(process.argv.includes("--check")){if(ocUpdated!==ocSource)throw Error("OpenClaw MCP contract guard stale");}else fs.writeFileSync(oc,ocUpdated);
const manifestPath=path.join(__dirname,"../resources/external-plugin-adapters/openclaw/openclaw.plugin.json");
const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
const {GROUP_MCP_TOOL_DEFINITIONS}=require("../app/agent-service/group-mcp-tools");
manifest.contracts.tools=[...GROUP_MCP_TOOL_DEFINITIONS,...contract.tools,...contract.deviceTools,...contract.sharedSkillTools].map(tool=>tool.name);
const manifestOutput=JSON.stringify(manifest,null,2)+"\n";
if(process.argv.includes("--check")){if(fs.readFileSync(manifestPath,"utf8")!==manifestOutput)throw Error("OpenClaw declared tools stale");}else fs.writeFileSync(manifestPath,manifestOutput);
console.log("MCP connector adapter contracts match Service tools");
