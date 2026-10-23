#!/usr/bin/env node
'use strict';
// The unchanged full original launcher runs ONLY initialize/tools-list under
// a real Service plan and owning metadata lease. No original tool business,
// model turn, user authentication, SDK worker, scans or live daemon.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createContext, repoRoot } = require('./fixtures/codex-security-native-factory-context.cjs');
const { CodexSecurityNativeJobStore } = require('../app/agent-service/codex-security-native-job-store');
const { CODEX_SECURITY_NATIVE_ENV_INVENTORY } = require('../app/agent-service/codex-security-native-host-plan');
const EXPECTED_BINARY_SHA = '16593cc2f422d5f398a8e40f550ebbaf1245392528957be342c295920a300704';
const SOURCES = ['app/agent-service/codex-security-native-host-plan.js','app/agent-service/codex-security-native-job-store.js',
  'app/agent-service/codex-runtime-host.js','app/agent-service/codex-schema-contract.js','app/agent-service/codex-jsonl-rpc.js',
  'app/agent-service/codex-rpc-safety.js','app/agent-service/codex-runtime-paths.js','app/agent-service/runtime-account-resolver.js',
  'app/agent-service/runtime-account-admission.js','app/agent-service/host-capability-issuer.js','app/agent-service/work-run.js',
  'app/agent-service/product-store.js','app/agent-service/plugin-store.js','app/agent-service/plugin-component-resolver.js',
  'app/agent-service/plugin-package-installer.js','app/agent-service/plugin-legacy-source.js','app/agent-service/plugin-dependency-registry.js',
  'app/agent-service/private-file.js','app/agent-service/private-writer-lease.js','app/core/bundled-plugin-catalog.js',
  'scripts/codex-security-native-host-plan-fixture.cjs','scripts/fixtures/codex-security-native-factory-context.cjs',
  'resources/bundled-plugins/packages/codex-security/.mcp.json','resources/bundled-plugins/packages/codex-security/.codex-plugin/plugin.json',
  'resources/bundled-plugins/packages/codex-security/scripts/launch_codex_security_mcp',
  'resources/bundled-plugins/packages/codex-security/mcp/server.mjs',
  'schemas/codex-app-server/0.159.2/schema-manifest.json',
  'schemas/codex-app-server/0.159.2/json/codex_app_server_protocol.schemas.json',
  'schemas/codex-app-server/0.159.2/json/codex_app_server_protocol.v2.schemas.json'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(SOURCES.map(file => [file, sha(fs.readFileSync(path.join(repoRoot, file)))]));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function processRows() {
  const ps = spawnSync('/bin/ps', ['-axo','pid=,ppid=,pgid=,comm='], { encoding:'utf8', maxBuffer:2*1024*1024, timeout:5000 });
  assert.equal(ps.status,0); assert.equal(ps.signal,null);
  return ps.stdout.trim().split('\n').map(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line); return m ? {pid:+m[1],ppid:+m[2],pgid:+m[3],comm:m[4]} : null; }).filter(Boolean);
}
async function main() {
  const output = process.argv[2]; assert.equal(process.argv.length,3);
  assert.ok(path.dirname(output) === '/private/tmp' && !fs.existsSync(output),'fresh exact output');
  const before = hashes(), checks=[], methods=[], nativeChildren=[], kills=[], spawnEnvironmentNames=[];
  process.env.OPENAI_API_KEY = 'isolated-fixture-sentinel-must-not-inherit';
  process.env.CODEX_API_KEY = 'isolated-fixture-sentinel-must-not-inherit';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  process.env.NODE_OPTIONS = '--require=/isolated/fixture/not-loadable.cjs';
  let c, plan, host, exit, ownedMcpPids=[], gate=null, success=false, failure, monitor=null, originalRoot=null;
  const observedMcp=new Map();
  const observeMcp=()=>{
    const probe=spawnSync('/usr/bin/pgrep',['-f',originalRoot+'/'],{encoding:'utf8',timeout:5000});
    assert.ok([0,1].includes(probe.status));
    for(const id of probe.stdout.trim().split(/\s+/u).filter(Boolean).map(Number)){
      const q=spawnSync('/bin/ps',['-p',String(id),'-o','pid=,ppid=,pgid=,comm='],{encoding:'utf8',timeout:5000});
      if(q.status!==0)continue;
      const command=spawnSync('/bin/ps',['-p',String(id),'-o','command='],{encoding:'utf8',timeout:5000});
      if(command.status!==0)continue;
      const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(q.stdout.trim());
      if(m&&command.stdout.includes(originalRoot)&&command.stdout.includes('--stdio'))observedMcp.set(id,{pid:id,ppid:+m[2],pgid:+m[3],comm:m[4],command:command.stdout.trim()});
    }
  };
  c = createContext({ onNativeHost(actualHost) {
    host=actualHost;
    const recordFile=fs.readdirSync(c.jobs.directory).find(name=>/^[a-f0-9]{64}\.json$/.test(name));
    const record=JSON.parse(fs.readFileSync(path.join(c.jobs.directory,recordFile))).record;
    assert.equal(record.state,'starting'); assert.equal(record.nativeThreadId,null);
    const realSpawn = host.spawnProcess;
    host.spawnProcess = (command,args,options) => {
      assert.equal(sha(fs.readFileSync(command)),EXPECTED_BINARY_SHA);
      assert.equal(options.env.OPENAI_API_KEY,undefined); assert.equal(options.env.CODEX_API_KEY,undefined);
      assert.equal(options.env.HTTPS_PROXY,undefined); assert.equal(options.env.NODE_OPTIONS,undefined);
      assert.equal(options.env.PATH,'/usr/bin:/bin'); assert.ok(options.env.HOME.startsWith(c.root+'/'));
      assert.ok(options.env.CODEX_HOME.startsWith(c.paths.runtimeAccountsDir+'/'));
      spawnEnvironmentNames.push(Object.keys(options.env).sort());
      const child=realSpawn(command,args,options); nativeChildren.push(child.pid);
      const write=child.stdin.write.bind(child.stdin);
      child.stdin.write=(chunk,...rest)=>{for(const line of String(chunk).split('\n').filter(Boolean)) {
        const frame=JSON.parse(line); methods.push(frame.method||null);
        assert.ok(!/^(?:turn\/|mcpServer\/tool\/call|account\/login|account\/logout)/u.test(frame.method||''));
      } return write(chunk,...rest);};
      child.once('exit',(code,signal)=>{exit={pid:child.pid,code,signal};}); return child;
    };
    const kill=host.killProcessGroup;
    host.killProcessGroup=(pid,signal)=>{kills.push({pid,signal});return kill(pid,signal);};
    const status=host.mcpServerStatusList.bind(host);
    host.mcpServerStatusList=async(...args)=>{
      const value=await status(...args);
      const tools=Object.values(value.data.find(item=>item.name==='codex-security')?.tools||{});
      if(!gate){
        const app=tools.filter(tool=>tool._meta?.ui?.visibility?.includes('app')).length;
        const model=tools.filter(tool=>tool._meta?.ui?.visibility?.includes('model')).length;
        assert.equal(tools.length,45); assert.equal(app,25); assert.equal(model,20);
        checks.push({name:'unchanged original45 tools retain25 App/20 model visibility',passed:true,app,model});
      } else {gate.started.resolve();await gate.release.promise;}
      return value;
    };
  }});
  try {
    const input={operationId:'original-security-metadata-operation',installationId:c.installation.installationId};
    plan=c.factory.prepare(input,c.lease);
    const candidate=c.factory.originalComponentCandidate(plan,c.lease);
    assert.equal(candidate.registered,true); assert.equal(Object.keys(candidate.spec).length,6);
    assert.equal(candidate.spec.env_vars.length,43); assert.equal(candidate.spec.startup_timeout_sec,120); assert.equal(candidate.spec.tool_timeout_sec,349200);
    originalRoot=candidate.spec.cwd;
    assert.equal(sha(fs.readFileSync(candidate.spec.command)),candidate.sourceFiles['scripts/launch_codex_security_mcp']);
    assert.equal(fs.statSync(originalRoot).mode&0o777,0o500);
    assert.equal(fs.statSync(candidate.spec.command).mode&0o777,0o500);
    checks.push({name:'actual installed native component exists; metadata full frozen source stage is SHA bound and private readonly',passed:true,
      sourceDigest:candidate.installation.sourceDigest,releaseDigest:candidate.installation.releaseDigest,sourceFiles:candidate.sourceFiles});
    assert.throws(()=>c.factory.assertFullToolEgress(plan,c.lease),{code:'CODEX_SECURITY_NATIVE_NATIVE_TURN_AND_DISPATCH_TICKET_REQUIRED'});
    checks.push({name:'installed source registration grants no Binding/Grant/dispatcher ticket or scanner permission',passed:true});
    monitor=setInterval(observeMcp,30);
    const started=await c.factory.startMetadata(plan,c.lease); observeMcp();
    assert.equal(started.state,'native_ready'); assert.equal(started.hasNativeThread,true);
    assert.equal(nativeChildren.length,1); assert.equal(host.runtimeVersion,'0.159.2');
    assert.deepEqual(await host.accountRead({refreshToken:false}),{account:null,requiresOpenaiAuth:true});
    assert.equal(fs.existsSync(path.join(host.runtimeEnvironment.home,'auth.json')),false);
    const recordFile=fs.readdirSync(c.jobs.directory).find(name=>/^[a-f0-9]{64}\.json$/.test(name));
    const record=JSON.parse(fs.readFileSync(path.join(c.jobs.directory,recordFile))).record;
    assert.equal(record.state,'native_ready'); assert.ok(record.nativeThreadId.length>10);
    assert.equal(record.scanId,null);
    checks.push({name:'durable start intent precedes real process/thread; actual native account/read remains null',passed:true,
      nativeThreadIdSha256:sha(record.nativeThreadId),modelTurnStarted:false,scanStarted:false});
    const catalog=await c.factory.listNativeTools(plan,c.lease);
    assert.equal(catalog.toolCount,45); assert.equal(new Set(catalog.toolNames).size,45);
    assert.equal(catalog.fullPluginUsable,false); assert.equal(catalog.originalToolsUnlocked,false);
    const rows=processRows(); ownedMcpPids=rows.filter(row=>row.ppid===nativeChildren[0]).map(row=>row.pid);
    observeMcp();
    const children=rows.filter(row=>ownedMcpPids.includes(row.pid));
    const childCommands=children.map(row=>{
      const query=spawnSync('/bin/ps',['-p',String(row.pid),'-o','command='],{encoding:'utf8',timeout:5000});
      assert.equal(query.status,0); return {...row,command:query.stdout.trim()};
    });
    assert.ok(childCommands.every(row=>!/[\/]git(?: |$)|ls-remote/u.test(row.command)),'metadata host disables actual default marketplace fetch');

    const stdio=[...observedMcp.values()].filter(row=>(row.command.includes(originalRoot+'/scripts/../mcp/server.mjs')||row.command.includes(path.join(originalRoot,'mcp/server.mjs')))&&row.command.includes('--stdio'));
    assert.ok(stdio.length>=1&&stdio.length<=4,'actual original stdio child present within bounded native owned group');
    assert.ok(stdio.every(row=>row.ppid===nativeChildren[0]),'every observed original MCP child belongs to exact native PID');
    assert.ok(childCommands.every(row=>!row.command.includes('codex exec')),'no SDK worker');
    ownedMcpPids=stdio.map(row=>row.pid);
    const command=spawnSync('/bin/ps',['-p',String(ownedMcpPids[0]),'-o','command='],{encoding:'utf8',timeout:5000});
    assert.equal(command.status,0); assert.ok(command.stdout.includes(originalRoot+'/scripts/../mcp/server.mjs')||command.stdout.includes(path.join(originalRoot,'mcp/server.mjs')));
    assert.ok(command.stdout.includes('--stdio'));
    checks.push({name:'actual pinned Codex runs unchanged original launcher and full45-tool directory only',passed:true,
      originalToolCallCount:methods.filter(method=>method==='mcpServer/tool/call').length,originalMcpChildCount:ownedMcpPids.length,originalMcpProcesses:stdio.map(({pid,ppid,pgid})=>({pid,ppid,pgid})),toolNames:catalog.toolNames});
    assert.equal(methods.filter(method=>method==='thread/start').length,1);
    assert.ok(!methods.some(method=>/^turn\/|mcpServer\/tool\/call|login/u.test(method||'')));
    checks.push({name:'native/MCP environment closes all ambient credentials/options/proxies; no model/business/auth RPC',passed:true,
      forwardedNameCount:43,providedServiceEnvironmentNames:spawnEnvironmentNames[0],unsetNames:CODEX_SECURITY_NATIVE_ENV_INVENTORY.filter(item=>!spawnEnvironmentNames[0].includes(item.name)).map(item=>item.name)});
    gate={started:deferred(),release:deferred()};
    const late=c.factory.listNativeTools(plan,c.lease);
    await gate.started.promise; c.issuer.revoke(c.lease); gate.release.resolve();
    await assert.rejects(late,{code:'HOST_CAPABILITY_REVOKED'});
    assert.equal(methods.filter(method=>method==='thread/start').length,1);
    checks.push({name:'real completed metadata response delayed past actual owner revocation cannot publish or start another thread',passed:true});
    await c.factory.closeMetadata(plan,c.lease);
    assert.equal(await c.factory.closeMetadata(plan,c.lease),true);
    assert.ok(exit&&exit.pid===nativeChildren[0]); assert.equal(host.child,null); assert.equal(host.cleanupIncomplete,false);
    clearInterval(monitor); monitor=null;
    const allObservedMcp=[...observedMcp.values()].map(({pid,ppid,pgid})=>({pid,ppid,pgid}));
    const remaining=processRows().filter(row=>row.pgid===nativeChildren[0]||observedMcp.has(row.pid)); assert.equal(remaining.length,0);
    const sourceRemaining=spawnSync('/usr/bin/pgrep',['-f',originalRoot+'/'],{encoding:'utf8',timeout:5000});
    assert.equal(sourceRemaining.status,1,'zero process retains this exact owned original source path after close');
    const terminal=JSON.parse(fs.readFileSync(path.join(c.jobs.directory,recordFile))).record;
    assert.equal(terminal.state,'metadata_closed'); assert.equal(terminal.nativeThreadId,record.nativeThreadId);
    c.jobs.close(); const reopened=new CodexSecurityNativeJobStore({paths:c.paths}).open();
    const scope={operationId:record.operationId,requestDigest:record.requestDigest,owner:record.owner};
    assert.equal(reopened.observe(scope).state,'metadata_closed');
    assert.throws(()=>reopened.prepare({...scope,installation:record.installation,planDigest:record.planDigest}),{code:'CODEX_SECURITY_JOB_OBSERVE_ONLY'});
    reopened.close();
    checks.push({name:'exact native/MCP group cleanup verified; terminal original ID survives real file reopen without replay',passed:true,
      nativeExit:exit,groupSignals:kills,allObservedMcpProcesses:allObservedMcp,zeroExactSourceProcessesAfterClose:true,cleanupKind:'existing CodexRuntimeHost group termination; not a natural scanner shutdown proof'});
    const after=hashes(); assert.deepEqual(after,before); success=true;
    // Cleanup must finish before PASS evidence, and uses only this owned exact root.
    await c.close(); c=null;
    const result={version:1,verified:true,scope:'Service factory -> pinned0.159.2 -> unchanged original0.1.24 stdio metadata only',
      checks,count:checks.length,codeHashesBefore:before,codeHashesAfter:after,nativeBinarySha256:EXPECTED_BINARY_SHA,
      naturalMainExitRequired:true,fullPluginUsable:false,originalToolsUnlocked:false,pluginConversionCountUnchanged:'29/31',
      modelTurnCount:0,originalToolBusinessCount:0,scanCount:0,registeredOriginalComponent:true,remaining:['Binding/Connection/Grant and dispatcher egress',
        'owned real native turn metadata and model authorization','App25 tool publication','Deep SDK separate auth','97h durable scan observe/cancel/recovery','rights approval']};
    fs.writeFileSync(output,`${JSON.stringify(result,null,2)}\n`,{mode:0o600,flag:'wx'});
    console.log(`PASS ${checks.length}/${checks.length} real original Codex Security metadata-only groups;0scan/0toolbusiness`);
  } catch(error) {failure=error;throw error;}
  finally {
    if(monitor)clearInterval(monitor);
    if(c){
      if(gate)gate.release.resolve();
      let cleanupError=null; try{await c.close({cleanup:!failure});}catch(error){cleanupError=error;}
      if(failure&&!fs.existsSync(output))fs.writeFileSync(output,`${JSON.stringify({version:1,verified:false,errorCode:failure.code||null,
        error:failure.message,checks,nativeExit:exit||null,groupSignals:kills,retainedFixtureRoot:c.root,
        cleanupError:cleanupError?.code||cleanupError?.message||null,codeHashesBefore:before,codeHashesAfter:hashes()},null,2)}\n`,{mode:0o600,flag:'wx'});
      if(cleanupError&&!failure)throw cleanupError;
    }
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
