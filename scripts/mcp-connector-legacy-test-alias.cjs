"use strict";
const {spawnSync}=require("node:child_process");
const mapping=require("./mcp-connector-retired-test-map.json"),name=process.argv[2],entry=mapping[name];
if(!entry){console.error("Unknown retired connector test alias");process.exitCode=2;}
else {console.log(`${name}: OpenConnector suite retired; executing ${entry.replacement} (new MCP contract)`);const result=spawnSync(process.platform==="win32"?"npm.cmd":"npm",["run",entry.replacement],{stdio:"inherit",shell:false});process.exitCode=result.status??1;}
