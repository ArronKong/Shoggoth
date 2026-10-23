'use strict';
// Reproducible development generator. App execution uses the hash-gated manager,
// never this script and never an in-place edit of an installed Host.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const REPO = process.env.SHOGGOTH_MANAGED_PATCH_REPO || path.resolve(__dirname, '..');
const { snapshotRuntimeTree, patchedTreeDigest } = require(path.join(REPO, 'app/managed-plugin-host-runtime'));
const SOURCE = '/opt/homebrew/lib/node_modules/openclaw';
const BASE = path.join(REPO, 'resources/external-plugin-host-patches/openclaw/2026.9.5');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function generate(output, helperRoot) {
  assert.ok(path.isAbsolute(output) && path.isAbsolute(helperRoot));
  assert.ok(!fs.existsSync(output), 'output must be a new directory');
  const pins = JSON.parse(fs.readFileSync(path.join(REPO,'app/managed-plugin-host-runtime-pins.json')));
  const input = snapshotRuntimeTree(SOURCE);
  assert.equal(input.sha256,pins.hosts.openclaw.inputTreeSha256,'entire original input must match');
  const manifest = JSON.parse(fs.readFileSync(path.join(BASE,'openclaw-2026.9.5-selection.json')));
  const edit = (rel, before, after) => {
    let file = manifest.files.find(item=>item.path===rel);
    if (!file) {
      file = {path:rel,beforeSha256:sha(fs.readFileSync(path.join(SOURCE,rel))),afterSha256:null,edits:[]};
      manifest.files.push(file);
    }
    file.edits.push({before,after});
  };
  const admission = 'dist/gateway-work-admission-8IGGoS0B.mjs';
  edit(admission, 'import { t as createDeferredCore }', 'import { isManagedGatewayPaused } from "./shoggoth-managed-admission.mjs";\nimport { t as createDeferredCore }');
  edit(admission,'function isGatewayWorkAdmissionClosed() {\n\treturn ',
    'function isGatewayWorkAdmissionClosed() {\n\treturn isManagedGatewayPaused() || ');
  edit(admission,'\tif (current) return current.released;\n\treturn GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting";',
    '\tif (current) return current.released;\n\treturn isManagedGatewayPaused() || GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting";');
  edit(admission,'function getGatewaySuspendAdmissionPhase() {\n\treturn GATEWAY_WORK_ADMISSION_STATE.suspendPhase;',
    'function getGatewaySuspendAdmissionPhase() {\n\tif (isManagedGatewayPaused() && GATEWAY_WORK_ADMISSION_STATE.suspendPhase === "accepting") return GATEWAY_WORK_ADMISSION_STATE.activeRootWork.size > 0 ? "draining" : "prepared";\n\treturn GATEWAY_WORK_ADMISSION_STATE.suspendPhase;');
  edit(admission,'\t};\n\tif (GATEWAY_WORK_ADMISSION_STATE.restartDraining || GATEWAY_WORK_ADMISSION_STATE.restartSignalPending || GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting") return null;\n\treturn createGatewayRootWorkAdmission(origin);',
    '\t};\n\tif (isManagedGatewayPaused() || GATEWAY_WORK_ADMISSION_STATE.restartDraining || GATEWAY_WORK_ADMISSION_STATE.restartSignalPending || GATEWAY_WORK_ADMISSION_STATE.suspendPhase !== "accepting") return null;\n\treturn createGatewayRootWorkAdmission(origin);');
  edit(admission,'function tryBeginGatewayIndependentRootWorkAdmission(origin = "independent") {\n\tif (',
    'function tryBeginGatewayIndependentRootWorkAdmission(origin = "independent") {\n\tif (isManagedGatewayPaused() || ');
  edit(admission,'function tryBeginGatewayRestartStartupRootWorkAdmission() {\n',
    'function tryBeginGatewayRestartStartupRootWorkAdmission() {\n\tif (isManagedGatewayPaused()) return null;\n');
  edit(admission,'function tryBeginGatewayPreparedRestartRootWorkAdmission() {\n',
    'function tryBeginGatewayPreparedRestartRootWorkAdmission() {\n\tif (isManagedGatewayPaused()) return null;\n');
  edit(admission,'//#region src/process/gateway-work-admission.ts',
    'export function notifyManagedGatewayAdmissionChange() { resolveSuspendOpenWaiters(); notifyGatewaySuspendAdmission(); }\n//#region src/process/gateway-work-admission.ts');
  const methods = ['status','pause','resume','retire'].map(kind=>`gateway.shoggoth.managed.${kind}`);
  edit('dist/server-methods-C72cO74x.mjs','const CORE_GATEWAY_HANDLER_MODULES = {',
    'const CORE_GATEWAY_HANDLER_MODULES = {\n\t"shoggoth-managed": () => import("./shoggoth-managed-runtime.mjs").then(module => module.managedRuntimeHandlers),');
  edit('dist/server-methods-C72cO74x.mjs','const SUSPEND_CONTROL_METHODS = /* @__PURE__ */ new Set([',
    'const SUSPEND_CONTROL_METHODS = /* @__PURE__ */ new Set([\n'+methods.map(name=>'\t'+JSON.stringify(name)+',').join('\n'));
  edit('dist/method-scopes-CF6Mdynq.mjs','const CORE_GATEWAY_METHOD_SPECS = [',
    'const CORE_GATEWAY_METHOD_SPECS = [\n'+methods.map(name=>'\t'+JSON.stringify([name,'shoggoth-managed','operator.admin','2026.9.5-shoggoth-managed-v1'])+',').join('\n'));
  for (const helper of ['shoggoth-managed-admission.mjs','shoggoth-managed-runtime.mjs']) {
    manifest.newFiles.push({path:`dist/${helper}`,source:helper,sha256:sha(fs.readFileSync(path.join(helperRoot,helper)))});
  }
  for (const rel of ['dist/gateway-active-work-OAr0e9ce.mjs','dist/server-active-work-DMRG0p1i.mjs'])
    manifest.dependencies.push({path:rel,sha256:sha(fs.readFileSync(path.join(SOURCE,rel)))});
  const changes=[];
  for (const file of manifest.files) {
    const bytes=fs.readFileSync(path.join(SOURCE,file.path));
    assert.equal(sha(bytes),file.beforeSha256);
    let output=bytes.toString('utf8');
    for (const item of file.edits) {
      const index=output.indexOf(item.before);
      assert.ok(index>=0 && output.indexOf(item.before,index+1)<0,`unique anchor ${file.path}`);
      output=output.slice(0,index)+item.after+output.slice(index+item.before.length);
    }
    file.afterSha256=sha(output); changes.push({path:file.path,bytes:Buffer.from(output)});
  }
  fs.mkdirSync(output,{mode:0o700});
  for (const name of ['LICENSE','THIRD_PARTY_NOTICES.md','shoggoth-capability-selection.mjs'])
    fs.copyFileSync(path.join(BASE,name),path.join(output,name));
  for (const name of ['shoggoth-managed-admission.mjs','shoggoth-managed-runtime.mjs'])
    fs.copyFileSync(path.join(helperRoot,name),path.join(output,name));
  for (const item of manifest.newFiles) changes.push({path:item.path,bytes:fs.readFileSync(path.join(output,item.source))});
  manifest.managedProtocol='openclaw-managed-v1';
  fs.writeFileSync(path.join(output,'openclaw-2026.9.5-managed.json'),JSON.stringify(manifest,null,2)+'\n');
  const pin={...pins.hosts.openclaw,managedProtocol:'openclaw-managed-v1',
    outputTreeSha256:patchedTreeDigest(input,changes), payloadTreeSha256:snapshotRuntimeTree(output).sha256,
    payloadManifestSha256:sha(fs.readFileSync(path.join(output,'openclaw-2026.9.5-managed.json'))),
    payloadRelative:'openclaw/2026.9.5-managed-v1',manifestFile:'openclaw-2026.9.5-managed.json'};
  return {version:1,hosts:{openclaw:pin},provenance:{scope:'Exact local original input and dependencies; managed-v1 is an App-owned compatibility layer, not an official upstream version'}};
}
if (require.main===module) {
  const [output,helperRoot,pinsFile]=process.argv.slice(2);
  const pins=generate(output,helperRoot);
  fs.writeFileSync(pinsFile,JSON.stringify(pins,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({status:'PASS',sourceWrites:0,output,payloadSha256:pins.hosts.openclaw.payloadTreeSha256,outputTreeSha256:pins.hosts.openclaw.outputTreeSha256})+'\n');
}
module.exports={generate};
