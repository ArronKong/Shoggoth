#!/usr/bin/env node
"use strict";
// Real sealed Hermes tool pipeline with only synthetic files and no Provider.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const policy = require("./group-collaboration-live-policy.cjs"), hermes = require("./group-collaboration-hermes-runtime.cjs"), external = require("./group-collaboration-live-external.cjs"), matrix = require("./group-collaboration-live-matrix.cjs");
const args = process.argv.slice(2), flag = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; }, sha = value => crypto.createHash("sha256").update(value).digest("hex");
async function main() {
  const disk = fs.statfsSync("/private/tmp"); assert(disk.bavail * disk.bsize >= 1024 ** 3, "GROUP_LIVE_DISK_SPACE_LOW");
  const runtimeRoot = flag("--runtime-root"), output = flag("--output"); assert(runtimeRoot && output?.startsWith("/private/tmp/") && !fs.existsSync(output));
  const archive = hermes.loadArchive(runtimeRoot), marker = JSON.parse(fs.readFileSync(path.join(runtimeRoot, ".group-collaboration-owned-hermes-runtime.json")));
  const root = fs.mkdtempSync("/private/tmp/sggroup-live-"); fs.chmodSync(root, 0o700);
  const state = path.join(root, "hermes"), home = path.join(root, "home"), workspace = path.join(root, "workspace");
  for (const directory of [state, home, workspace]) fs.mkdirSync(directory, { mode: 0o700 });
  const canary = path.join(root, "outside-canary.txt"), canaryText = "synthetic-owned-hermes-canary-v1";
  fs.writeFileSync(canary, canaryText, { mode: 0o600 }); fs.symlinkSync(canary, path.join(workspace, "alias.txt"));
  const prepared = policy.preparePolicy({ root, workspace, readRoots: [workspace], runtime: "hermes", caseId: "implementation-review",
    groupTools: ["group_member_role_read", "group_messages_read", "group_task"], hookCwd: home });
  const hook = policy.writeHermesHook({ root, prepared, nodePath: fs.realpathSync(process.execPath) });
  const config = { terminal: { cwd: workspace, env_type: "local" }, toolsets: ["terminal", "file", "mcp"], plugins: {}, skills: { enabled: false },
    memory: { enabled: false, memory_enabled: false, user_profile_enabled: false }, cron: { enabled: false }, hooks: { pre_tool_call: [{ command: hook.command, timeout: 5, fail_closed: true }] } };
  fs.writeFileSync(path.join(state, "config.yaml"), require("js-yaml").dump(config), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "shell-hooks-allowlist.json"), JSON.stringify({ approvals: [{ event: "pre_tool_call", command: hook.command }] }), { mode: 0o600 });
  const input = { application: marker.application, workspace, processCwd: home, canary }, script = path.join(root, "real-hermes-tool-probe.py");
  fs.writeFileSync(script, `import sys,json,os,socket,uuid\np=json.loads(sys.stdin.read());sys.path.insert(0,p['application'])\nnetwork_attempts=[]\ndef denied_connect(self,target):\n network_attempts.append(str(target));raise RuntimeError('ZERO_PROVIDER_NETWORK_GUARD')\nsocket.socket.connect=denied_connect\nimport model_tools\nfrom hermes_cli.config import load_config\nfrom agent.shell_hooks import register_from_config\nspecs=register_from_config(load_config());assert len(specs)==1 and specs[0].fail_closed\nfrom tools.terminal_tool import record_session_cwd,cleanup_all_environments\nsid='owned-'+str(uuid.uuid4());record_session_cwd(sid,p['workspace'])\nrequests=[('write_file',{'path':'sum-valid.cjs','content':\"module.exports=xs=>xs.reduce((a,b)=>a+(typeof b==='number'&&Number.isFinite(b)?b:0),0);\"}),('read_file',{'path':'sum-valid.cjs'}),('read_file',{'path':p['canary']}),('read_file',{'path':'alias.txt'}),('write_file',{'path':p['canary'],'content':'wrong'}),('write_file',{'path':'package.json','content':'{}'}),('terminal',{'command':'cat '+p['canary']}),('web_fetch',{'url':'https://invalid.example.test/owned-policy'}),('mcp__other__read_private',{})]\nresults=[]\ntry:\n for name,args in requests:\n  result=model_tools.handle_function_call(name,args,task_id=sid,session_id=sid,tool_call_id=str(uuid.uuid4()),turn_id='synthetic-tool-body-probe')\n  try:parsed=json.loads(result)\n  except:parsed={'unparsed':result}\n  results.append({'name':name,'arguments':args,'result':parsed})\nfinally:cleanup_all_environments()\nprint(json.dumps({'sessionId':sid,'officialRegisteredHookCount':len(specs),'actualProcessCwd':os.getcwd(),'configuredRoleWorkspace':p['workspace'],'results':results,'networkAttempts':network_attempts}))\n`, { mode: 0o400 });
  const report = { version: 1, root, startedAt: new Date().toISOString(), runtimeBefore: archive.evidence, providerCalls: 0,
    providerProof: "no-agent-or-generation-created;all-network-connect-attempts-blocked-before-socket-connect", coverage: "sealed-installed-Hermes-real-model_tools.handle_function_call/official-fail_closed-pre_tool_hook/real-file-bodies;dashboard-equivalent-owned-process-cwd;no-model-turn", policy: { file: prepared.file, sha256: prepared.sha256, moduleSha256: prepared.moduleSha256, hookSha256: hook.sha256 } };
  let child, records = [], stdout = "", stderr = "", failed;
  try {
    child = spawn(marker.interpreter, ["-I", "-B", script], { cwd: home, env: { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TMPDIR: root,
      HOME: home, HERMES_HOME: state, HERMES_CWD: workspace, ...archive.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    records = external.captureOwnedProcesses({ ownedNativeProcesses: [{ proc: child, kind: "owned-hermes-tool-pipeline", detached: true }] });
    child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 1024 * 1024) child.kill("SIGTERM"); }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("OWNED_TOOL_PROBE_TIMEOUT")); }, 30_000);
      child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", code => { clearTimeout(timer); resolve(code); }); });
    assert.equal(code, 0, stderr.slice(-2048));
    report.actual = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(report.actual.actualProcessCwd, home); assert.equal(report.actual.configuredRoleWorkspace, workspace);
    assert.equal(report.actual.networkAttempts.length, 0);
    for (const row of report.actual.results.slice(2)) assert(JSON.stringify(row.result).includes("GROUP_LIVE_"), JSON.stringify(row));
    assert.equal(fs.readFileSync(canary,"utf8"), canaryText); assert.equal(fs.existsSync(path.join(workspace,"package.json")),false);
    report.artifact = matrix.artifactEvaluation(path.join(workspace,"sum-valid.cjs")); assert.equal(report.artifact.status,"passed");
    assert(JSON.stringify(report.actual.results[1].result).includes("module.exports")); report.canaryUnchanged = true; report.pass = true;
  } catch (error) { failed = error; report.pass = false; report.error = { code: error.code ?? null, message: error.message }; }
  finally {
    report.stopEvidence = await external.verifyOwnedProcessesStopped(records); report.stopped = report.stopEvidence.stopped;
    if(!report.stopped) { report.pass = false; failed ||= new Error("OWNED_HERMES_TOOL_PROCESS_STOP_UNPROVEN"); }
    report.stderrDigest = sha(stderr); report.stderrBytes = Buffer.byteLength(stderr);
    report.policyDecisions = fs.existsSync(prepared.policy.logPath) ? fs.readFileSync(prepared.policy.logPath,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    try { report.runtimeAfter = hermes.loadArchive(runtimeRoot).evidence; report.runtimeUnchanged = report.runtimeAfter.archiveDigest === report.runtimeBefore.archiveDigest; }
    catch(error) { report.runtimeUnchanged = null; report.runtimeObservationError = error.code ?? null; }
    report.finishedAt = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(matrix.safeEvidence(report),null,2)+"\n", { flag: "wx", mode: 0o600 });
  }
  assert.equal(report.runtimeUnchanged,true); if(failed) throw failed;
  console.log("PASS actual Hermes tool pipeline: owned file read/write, rejected outside/symlink/config/shell/network/unknown tools; Provider 0; process/group absent");
}
main().catch(error => { console.error(error.code ?? "OWNED_HERMES_TOOL_POLICY_PROBE_FAILED",error.message);process.exitCode=1; });
