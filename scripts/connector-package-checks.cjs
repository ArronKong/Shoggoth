"use strict";
// Historical module name retained for release tooling compatibility. OpenConnector
// is retired: the replacement check proves its resources cannot ship again.
const fs=require("node:fs"),path=require("node:path");
const RETIRED_RESOURCES=Object.freeze(["open-connector","open-connector-runtime","gogcli","bundled-plugins","shoggoth-plugins","shoggoth-skills/shoggoth-plugin-authoring"]);
function assertRetiredResourcesAbsent(root) {for(const relative of RETIRED_RESOURCES)if(fs.existsSync(path.join(root,relative)))throw new Error(`retired platform resource shipped: ${relative}`);}
function checkConnectorBuildInputs(repo) {
 try {assertRetiredResourcesAbsent(path.join(repo,"resources"));const config=path.join(repo,"electron-builder.yml");if(fs.existsSync(config)&&/from:\s*\.vendor\/open-connector/u.test(fs.readFileSync(config,"utf8")))throw new Error("retired OpenConnector package mapping remains");return [];}
 catch(e){return [`MCP connector package: ${e.message}`];}
}
async function checkPackagedConnector(appPath) {
 const resources=path.join(appPath,"Contents/Resources");assertRetiredResourcesAbsent(resources);
 const sbomPath=path.join(resources,"legal/release-sbom.cdx.json");if(fs.existsSync(sbomPath)) {
  const sbom=JSON.parse(fs.readFileSync(sbomPath,"utf8"));
  if((sbom.components||[]).some(c=>c.name==="@oomol-lab/open-connector"||(c.properties||[]).some(p=>p.name==="shoggoth:role"&&String(p.value).startsWith("open-connector-"))))throw new Error("retired OpenConnector dependency remains in package SBOM");
 }
 return {retired:true,resourcesAbsent:true};
}
function checkPublicConnectorRelease(repo=path.resolve(__dirname,"..")) {const problems=checkConnectorBuildInputs(repo);if(problems.length)throw new Error(problems.join("; "));return {retired:true};}
module.exports={RETIRED_RESOURCES,assertRetiredResourcesAbsent,checkConnectorBuildInputs,checkPackagedConnector,checkPublicConnectorRelease};
