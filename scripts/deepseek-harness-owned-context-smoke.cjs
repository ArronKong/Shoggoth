#!/usr/bin/env node
"use strict";

// Actual installed DSH final request assembly under the owned monotonic guard.
// Synthetic contexts are captured at llm/stream before the Provider; installations and source stay unchanged.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const worker = require("./group-collaboration-live-worker.cjs"), policyModule = require("./group-collaboration-live-policy.cjs");
const args = process.argv.slice(2);
const valueOf = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const source = fs.realpathSync(valueOf("--source-repo") || ROOT);
const outputPath = valueOf("--output");
const keepArtifacts = args.includes("--keep-artifacts");
const sourceModule = file => require(path.join(source, file));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fileHash = file => sha(fs.readFileSync(file));

function sourceEvidence() {
  let gitSha;
  const marker = path.join(source, ".group-collaboration-source-snapshot.json");
  if (fs.existsSync(marker)) gitSha = JSON.parse(fs.readFileSync(marker, "utf8")).gitSha;
  else gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  assert.match(gitSha, /^[a-f0-9]{40}$/u);
  const files = ["app/bootstrap-role.js", "app/runtime-mcp-relay.js", "app/agent-service/server.js",
    "app/agent-service/runtime-mcp-gate.js", "app/agent-service/work-run-coordinator.js",
    "app/agent-service/deepseek-harness-runtime-host.js", "app/agent-service/deepseek-harness-runtime-paths.js",
    "resources/deepseek-harness/shoggoth-dsh-bridge.mjs"];
  const hashes = Object.fromEntries(files.map(file => [file, fileHash(path.join(source, file))]));
  return { repo: source, gitSha, hashes, digest: sha(JSON.stringify(hashes)) };
}

async function main() {
  const { createAgentService } = sourceModule("app/agent-service/server.js");
  const { resolveCanonicalServicePaths } = sourceModule("app/agent-service/paths.js");
  const { RuntimeMcpGateIssuer } = sourceModule("app/agent-service/runtime-mcp-gate.js");
  const { NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID: account } = sourceModule("app/agent-service/runtime-account.js");
  const { resolveDeepSeekHarnessBinary } = sourceModule("app/agent-service/deepseek-harness-runtime-paths.js");
  let binary;
  try { binary = resolveDeepSeekHarnessBinary({ parentEnv: process.env }); }
  catch (error) {
    if (process.env.REQUIRE_DSH === "1") throw error;
    console.log("SKIP formal DSH MCP smoke: official DSH is not installed");
    return;
  }
  const disk = fs.statfsSync("/private/tmp"); assert(disk.bavail * disk.bsize >= 1024 ** 3, "GROUP_LIVE_DISK_SPACE_LOW");
  const sourceBefore = sourceEvidence();
  const nativeMcpPlugin = createRequire(pathToFileURL(binary)).resolve("@deepseek-ai/dsh-mcp-client");
  const nativeBefore = { entrypoint: fileHash(binary), mcpPlugin: fileHash(nativeMcpPlugin) };
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sggroup-live-"));
  fs.chmodSync(root, 0o700);
  const hostHome = path.join(root, "host-home");
  const nativeHome = path.join(hostHome, ".dsh");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(path.join(nativeHome, ".credentials.yaml"),
    "version: 1\nrefs:\n  DEEPSEEK_API_KEY: smoke-only\n", { mode: 0o600 });
  const paths = resolveCanonicalServicePaths({ userInfo: () => ({ ...os.userInfo(), homedir: hostHome }) });
  const bootstrap = path.join(root, "bootstrap.cjs");
  fs.writeFileSync(bootstrap, `"use strict";
const os = require("node:os");
const { main } = require(${JSON.stringify(path.join(source, "app/bootstrap-role.js"))});
Promise.resolve().then(() => main(process.argv.slice(1), process.env,
  { userInfo: () => ({ ...os.userInfo(), homedir: ${JSON.stringify(hostHome)} }) }))
  .catch(error => { process.stderr.write(String(error.code || "BOOTSTRAP_FAILED") + "\\n"); process.exitCode = 1; });
`, { mode: 0o600 });
  const tokens = { role: "SYNTHETIC_ALLOWED_DSH_ROLE_711e", userGlobal: "SYNTHETIC_DISABLED_DSH_HOME_882a", workspace: "SYNTHETIC_DISABLED_DSH_WORKSPACE_d93c", skill: "SYNTHETIC_DISABLED_DSH_SKILL_a1bd" };
  fs.writeFileSync(path.join(nativeHome,"AGENTS.md"),tokens.userGlobal+"\n",{mode:0o600});
  fs.writeFileSync(path.join(workspace,"AGENTS.md"),tokens.workspace+"\n",{mode:0o600});
  fs.mkdirSync(path.join(nativeHome,"skills","owned-poison"),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(nativeHome,"skills","owned-poison","SKILL.md"),"---\nname: owned-poison\ndescription: "+tokens.skill+"\n---\n"+tokens.skill+"\n",{mode:0o600});
  const preparedPolicy = policyModule.preparePolicy({ root, workspace, readRoots: [workspace], runtime: "deepseek-harness", caseId: "implementation-review", groupTools: ["group_member_role_read", "group_messages_read", "group_task"] });
  const guardPlugin = policyModule.writeDeepSeekPlugin({ root, prepared: preparedPolicy });
  const requestsFile=path.join(root,"captured-final-requests.json"),controlFile=path.join(root,"instructions-positive-control.json"),commandBridge=path.join(root,"bridge-probe.mjs");
  const sdkInstructions=createRequire(pathToFileURL(binary)).resolve("@deepseek-ai/dsh-agent-instructions");
  fs.writeFileSync(commandBridge,`import fs from "node:fs";
import {apply as nativeApply,inject as nativeInject} from ${JSON.stringify(pathToFileURL(path.join(source,"resources/deepseek-harness/shoggoth-dsh-bridge.mjs")).href)};
import {apply as guardApply} from ${JSON.stringify(pathToFileURL(guardPlugin.plugin).href)};
import {loadBaselineInstructions} from ${JSON.stringify(pathToFileURL(sdkInstructions).href)};
export const name="formal-owned-context-probe";export const inject=[...nativeInject,"tools"];
export async function apply(ctx){
 nativeApply(ctx);guardApply(ctx);
 globalThis.fetch=()=>{throw new Error("ZERO_PROVIDER_NETWORK_GUARD");};
 const requests=[];
 ctx.on("llm/stream",options=>{
  const body={provider:options.provider,model:options.model,messages:options.messages,system:options.system,tools:options.tools,sessionId:options.sessionId};requests.push(body);fs.writeFileSync(${JSON.stringify(requestsFile)},JSON.stringify(requests),{mode:0o600});
  throw new Error("ZERO_PROVIDER_FINAL_CONTEXT_CAPTURED");
 });
 const control=await loadBaselineInstructions({cwd:${JSON.stringify(workspace)},dshHome:${JSON.stringify(nativeHome)},maxBytes:32768,maxSourceBytes:32768});
 fs.writeFileSync(${JSON.stringify(controlFile)},JSON.stringify({workspaceMarkerObserved:control?.text.includes(${JSON.stringify(tokens.workspace)})===true,homeMarkerObserved:control?.text.includes(${JSON.stringify(tokens.userGlobal)})===true}),{mode:0o600});
}
`,{mode:0o600});
  const issuer = new RuntimeMcpGateIssuer({ paths, bootstrapPath: bootstrap,
    mcpHelperLaunch: { command: fs.realpathSync(process.execPath), argsPrefix: [bootstrap] } });
  const gateConsumptions = [];
  const originalConsume = issuer.consume.bind(issuer);
  issuer.consume = input => {
    const result = originalConsume(input);
    gateConsumptions.push({ runtimeProfileId: input.runtimeProfileId, runtimeAccountId: input.runtimeAccountId,
      parentPid: input.parentPid, executionRunId: result.executionRunId, consumed: result.consumed });
    return result;
  };
  const productCalls = [], events = [];
  const service = createAgentService({ paths, version: "dsh-formal-zero-provider",
    parentEnv: { PATH: process.env.PATH, HOME: hostHome, DSH_HOME: nativeHome, TMPDIR: os.tmpdir() },
    runtimeStorageHomedir: hostHome, deepSeekHarnessBinaryPath: binary,
    deepSeekHarnessBridgePath: commandBridge, builtinCliProfiles: true,
    builtinCliInstalledAccountIds: [account], prewarmMcpAuth: false, runtimeMcpGateIssuer: issuer,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString() },
    mcpProductToolController: { async handle(name, toolArgs, authority, scope) {
      assert.equal(name, "app_status");
      scope.assertCurrent();
      productCalls.push({ name, arguments: toolArgs, profileId: authority.profileId, runId: scope.runId });
      return { probe: "formal-dsh", runId: scope.runId };
    } },
  });
  const report = { sourceBefore, root, nativeBinary: binary, nativeMcpPlugin, nativeBefore,
    originalNativeMcpPlugin: true, controlledProductHandler: true,
    coverage: "official CLI/agent-loop-final-request/llm-stream-before-adapter;official disabled instructions+skills;synthetic context only;no native auth copied",
    policy: { file: preparedPolicy.file, sha256: preparedPolicy.sha256, module: preparedPolicy.module, moduleSha256: preparedPolicy.moduleSha256, plugin: guardPlugin.plugin, pluginSha256: guardPlugin.sha256 },
    startedAt: new Date().toISOString(), providerCalls: 0 };
  let failure, nativeProcesses;
  try {
    await service.start();
    const profile = service.productStore.listAgentProfiles().find(item => item.runtime === "deepseek-harness" && item.enabled);
    assert(profile);
    nativeProcesses = worker.observeOwnedNativeProcesses({ service, profiles: [profile], result: report });
    const session = service.chatSessionStore.createSession({ operationId: "formal-dsh-session",
      profileId: profile.id, workspace, createdAt: Date.now() });
    const ack = await service.workRunCoordinator.send({ operationId: "formal-dsh-context",
      sessionKey: session.sessionKey, prompt: tokens.role + " Only inspect this synthetic evaluation context; return the fixed completion sentence." });
    service.workRunCoordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    const deadline = Date.now() + 60_000;
    while (!new Set(["completed", "failed", "cancelled", "interrupted"]).has(
      service.workRunCoordinator.getRun(ack.run.id)?.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const run = service.workRunCoordinator.getRun(ack.run.id);
    report.run = { id: run.id, status: run.status, errorCode: run.errorCode,
      sessionRef: run.runtimeSessionRef, turnRef: run.runtimeTurnRef };
    assert(["failed","interrupted"].includes(run.status),"EXPECTED_PRE_PROVIDER_CAPTURE_STOP");
    assert.equal(productCalls.length,0);
    const requests=JSON.parse(fs.readFileSync(requestsFile,"utf8")),primary=requests.filter(row=>Array.isArray(row.tools) && row.messages?.some(message=>message.source?.kind==="user" && JSON.stringify(message.content).includes(tokens.role)));
    assert.equal(primary.length,1,"FINAL_PRIMARY_REQUEST_NOT_EXACTLY_ONE");
    const serialized=JSON.stringify(primary[0]),observed=Object.fromEntries(Object.entries(tokens).map(([key,value])=>[key,serialized.includes(value)]));
    assert.equal(observed.role,true);assert.equal(observed.workspace,false);assert.equal(observed.userGlobal,false);assert.equal(observed.skill,false);
    const control=JSON.parse(fs.readFileSync(controlFile,"utf8"));assert.equal(control.workspaceMarkerObserved,true);assert.equal(control.homeMarkerObserved,true);
    report.actual={requestCount:requests.length,primaryRequestCount:primary.length,auxiliaryRequests:requests.filter(row=>row!==primary[0]).map(row=>({provider:row.provider,model:row.model,sources:row.messages?.map(message=>message.source),requestDigest:sha(JSON.stringify(row))})),finalRequestDigest:sha(serialized),finalRequestBytes:Buffer.byteLength(serialized),provider:primary[0].provider,model:primary[0].model,toolNames:primary[0].tools?.map(tool=>tool.name)??[],markerObserved:observed,positiveInstructionControl:control,generationTransport:"installed-llm/stream-waterfall-capture-before-adapter-body"};
    report.pass = true;
  } catch (error) { failure = error; report.pass = false; report.error = { code: error.code || null, message: error.message }; }
  finally {
    report.nativeOwnedProcessSnapshot = nativeProcesses?.snapshot() ?? null;
    report.serviceStopEvidence = await worker.boundedStop(() => service.stop({ notify: false }));
    report.nativeStopEvidence = nativeProcesses ? await nativeProcesses.finish() : null;
    report.serviceStopped = report.serviceStopEvidence.stopped && report.nativeStopEvidence?.stopped === true;
    if(!report.serviceStopped) { report.pass=false; failure ||= new Error("GROUP_LIVE_OWNED_SERVICE_STOP_UNPROVEN"); }
    report.sourceAfter = sourceEvidence();
    report.nativeAfter = { entrypoint: fileHash(binary), mcpPlugin: fileHash(nativeMcpPlugin) };
    report.sourceBytesUnchanged = report.sourceBefore.digest === report.sourceAfter.digest;
    report.nativeInstallationUnchanged = JSON.stringify(report.nativeBefore) === JSON.stringify(report.nativeAfter);
    report.productCalls = productCalls;
    report.providerProof="official-llm/stream-intercept-throws-before-adapter-generation";
    report.policyDecisions = fs.existsSync(preparedPolicy.policy.logPath) ? fs.readFileSync(preparedPolicy.policy.logPath,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    report.gateConsumptions = gateConsumptions;
    report.events = events.filter(event => ["text", "status", "error", "usage"].includes(event.type));
    report.finishedAt = new Date().toISOString();
    if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (!keepArtifacts) fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(report.sourceBytesUnchanged, true);
  assert.equal(report.nativeInstallationUnchanged, true);
  if (failure) throw failure;
  console.log(`PASS actual DSH final request: synthetic role retained, disabled home/workspace instructions+skills absent, positive controls pass; exact WorkRun ${report.run.id}; zero Provider; stopped`);
}
main().catch(error => { console.error(`${error.code || "DSH_FORMAL_SMOKE_FAILED"}: ${error.message}`); process.exitCode = 1; });
