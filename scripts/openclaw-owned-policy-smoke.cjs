"use strict";
// Real official loader and coding-tool bodies, no model/auth/user sessions.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"),
  cp = require("node:child_process"), assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const policyModule = require("./group-collaboration-openclaw-policy.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sdkRoot = "/opt/homebrew/lib/node_modules/openclaw";
const sdkFiles = ["package.json", "dist/plugins/loader.js", "dist/loader-runtime-load-DpgEqnzx.mjs", "dist/agent-tools-HIqp3eTk.mjs",
  "dist/agent-tools.before-tool-call-Cg8vCu9u.mjs", "dist/hook-runner-global-CFWs616h.mjs"];
function reserve() { const stat = fs.statfsSync("/private/tmp"), available = stat.bavail * stat.bsize;
  if (available < 1024 ** 3) throw Object.assign(new Error("OPENCLAW_OWNED_POLICY_DISK_RESERVE_LOW"), { code: "OPENCLAW_OWNED_POLICY_DISK_RESERVE_LOW" }); return available; }
function fingerprints() { return Object.fromEntries(sdkFiles.map(file => [file, sha(fs.readFileSync(path.join(sdkRoot, file)))])); }
function write(file, bytes) { fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); }
async function childMain(jobFile) {
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8")), observations = [], blockedNetwork = [];
  // This process has only synthetic HOME/config and no original account env.
  // Reject a catalogue refresh as well as a model call before any connection.
  for (const [module, method] of [[require("node:net").Socket.prototype, "connect"], [require("node:tls"), "connect"]]) {
    module[method] = function() { blockedNetwork.push({ kind: method, pid: process.pid }); throw Object.assign(new Error("ZERO_PROVIDER_NETWORK_GUARD"), { code: "ZERO_PROVIDER_NETWORK_GUARD" }); };
  }
  if (globalThis.fetch) globalThis.fetch = async () => { blockedNetwork.push({ kind: "fetch", pid: process.pid }); throw Object.assign(new Error("ZERO_PROVIDER_NETWORK_GUARD"), { code: "ZERO_PROVIDER_NETWORK_GUARD" }); };
  const config = JSON.parse(fs.readFileSync(job.configFile, "utf8"));
  const { loadOpenClawPlugins } = await import(pathToFileURL(path.join(sdkRoot, "dist/plugins/loader.js")).href);
  const registry = await loadOpenClawPlugins({ config, workspaceDir: job.workspace, activate: true, cache: false });
  const registered = (registry.trustedToolPolicies ?? []).filter(row => row.pluginId === policyModule.PLUGIN_ID && row.policy.id === policyModule.POLICY_ID);
  assert.equal(registered.length, 1);
  assert.equal((registry.diagnostics ?? []).some(row => row.level === "error" && row.pluginId === policyModule.PLUGIN_ID), false);
  await policyModule.attestRegistration(job.evidence.policyFile, job.evidence.policySha256);
  const attestation = policyModule.verifyGuard(job.evidence, process.pid);
  const { t: createOpenClawCodingTools } = await import(pathToFileURL(path.join(sdkRoot, "dist/agent-tools-HIqp3eTk.mjs")).href);
  const tools = await createOpenClawCodingTools({ config, agentId: "main", sessionId: "owned-policy-session",
    sessionKey: "agent:main:owned-policy-session", runId: "owned-zero-provider-policy-run", cwd: job.workspace, workspaceDir: job.workspace,
    agentDir: path.join(job.root, "state/agents/main/agent"), wrapBeforeToolCallHook: true,
    senderIsOwner: true, modelProvider: "openai", modelId: "owned-synthetic-control" });
  const toolNames = tools.map(tool => tool.name), schemas = Object.fromEntries(tools.filter(tool => ["read", "write", "edit", "exec"].includes(tool.name)).map(tool => [tool.name, tool.parameters]));
  for (const name of ["read", "write", "edit", "exec"]) assert.ok(toolNames.includes(name), "actual SDK tool missing: " + name);
  let ordinal = 0;
  async function invoke(label, name, args, blocked) {
    const tool = tools.find(tool => tool.name === name), callId = "owned-call-" + (++ordinal);
    let value, error;
    try { value = await tool.execute(callId, args, new AbortController().signal); } catch (caught) { error = caught; }
    const isBlocked = value?.details?.status === "blocked" || value?.details?.deniedReason === "plugin-before-tool-call"
      || /GROUP_LIVE_OPENCLAW_/u.test(String(error?.message ?? ""));
    observations.push({ label, toolName: name, callId, argumentsDigest: sha(JSON.stringify(args)), blocked: Boolean(isBlocked),
      status: value?.details?.status ?? null, errorCode: error?.code ?? null,
      contents: value?.content?.filter(row => row.type === "text").map(row => row.text) ?? [] });
    assert.equal(Boolean(isBlocked), blocked, label);
    if (!blocked) assert.equal(Boolean(error), false, label);
    return value;
  }
  const artifact = path.join(job.workspace, "sum-valid.cjs"), content = "module.exports = values => values.reduce((s,x) => s + (typeof x === 'number' && Number.isFinite(x) ? x : 0),0);";
  await invoke("owned-write", "write", { path: "sum-valid.cjs", content }, false);
  assert.equal(fs.readFileSync(artifact, "utf8"), content);
  const read = await invoke("owned-read", "read", { path: "sum-valid.cjs" }, false);
  assert.ok(read.content.some(row => row.type === "text" && row.text.includes(content)));
  await invoke("outside-read", "read", { path: job.canary }, true);
  await invoke("outside-write", "write", { path: job.canary, content: "modified" }, true);
  await invoke("symlink-read", "read", { path: path.join(job.workspace, "escape", "canary.txt") }, true);
  await invoke("symlink-write", "write", { path: path.join(job.workspace, "escape", "canary.txt"), content: "modified" }, true);
  await invoke("package-write", "write", { path: "package.json", content: "{}" }, true);
  await invoke("policy-config-read", "read", { path: job.configFile }, true);
  const shellMarker = path.join(job.workspace, "forbidden-shell-marker");
  await invoke("shell-body-vetoed", "exec", { command: "printf control > " + shellMarker, workdir: job.workspace }, true);
  assert.equal(fs.existsSync(shellMarker), false);
  assert.equal(sha(fs.readFileSync(job.canary)), job.canaryDigest);
  const outcome = require("./group-collaboration-live-matrix.cjs").artifactEvaluation(artifact);
  assert.equal(outcome.status, "passed");
  const result = { passed: true, pid: process.pid, providerCalls: 0, modelPrompts: 0, authCalls: 0,
    provenance: "official-installed-plugin-loader-declared-trusted-policy-and-createOpenClawCodingTools-real-tool-bodies",
    attestation, registeredPolicyCount: registered.length, toolNames, schemas, observations, canaryUnchanged: true,
    shellBodyNotExecuted: true, artifact: outcome, blockedNetworkAttempts: blockedNetwork,
    diagnostics: (registry.diagnostics ?? []).filter(row => row.pluginId === policyModule.PLUGIN_ID).map(row => ({ level: row.level, message: row.message })) };
  fs.writeFileSync(job.childResult, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.send?.({ completed: true });
}
async function main() {
  const output = process.argv[2]; if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error("fresh absolute output required");
  const report = { reportVersion: 1, startedAt: new Date().toISOString(), status: "blocked", providerCalls: 0, modelPrompts: 0,
    installedVersion: JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")).version, installedBefore: fingerprints(), root: null };
  let child;
  try {
    report.availableBefore = reserve();
    const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sggroup-live-")); fs.chmodSync(root, 0o700); report.root = root;
    const workspace = path.join(root, "workspace/reviewer"), canaryDirectory = path.join(root, "private-canary"), home = path.join(root, "home"), state = path.join(root, "state");
    for (const directory of [workspace, canaryDirectory, home, state]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const canary = path.join(canaryDirectory, "canary.txt"); write(canary, "owned-synthetic-private-control-" + crypto.randomUUID());
    fs.symlinkSync(canaryDirectory, path.join(workspace, "escape"));
    const prepared = policyModule.prepareGuard({ root, workspace, readRoots: [workspace], caseId: "implementation-review",
      groupTools: ["group_member_role_read", "group_messages_read", "group_task"] });
    const configFile = path.join(root, "openclaw.json"), config = { agents: { defaults: { workspace }, list: [{ id: "main", workspace, skills: [] }] },
      tools: { profile: "coding", ...prepared.configOverlay.tools }, plugins: { ...prepared.configOverlay.plugins, slots: { memory: "none" } },
      logging: { file: path.join(root, "openclaw.runtime.log") }, cron: { enabled: false }, channels: {}, skills: { load: { extraDirs: [] } } };
    write(configFile, JSON.stringify(config));
    const childResult = path.join(root, "tool-body-result.json"), jobFile = path.join(root, "job.json");
    const job = { root, workspace, canary, canaryDigest: sha(fs.readFileSync(canary)), configFile, evidence: prepared.policyEvidence, childResult };
    write(jobFile, JSON.stringify(job)); report.policyEvidence = prepared.policyEvidence;
    reserve();
    child = cp.fork(__filename, ["--owned-child", jobFile], { cwd: root,
      env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", LANG: "C.UTF-8", HOME: home, TMPDIR: root,
        OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configFile, NODE_DISABLE_COMPILE_CACHE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: ["--max-old-space-size=512"] });
    report.pid = child.pid;
    let stderr = "", stdout = ""; child.stderr.on("data", bytes => { if (stderr.length < 16384) stderr += bytes.toString(); }); child.stdout.on("data", bytes => { if (stdout.length < 16384) stdout += bytes.toString(); });
    let timer;
    const exit = await new Promise((resolve, reject) => { timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("OWNED_POLICY_PROBE_TIMEOUT")); }, 60000);
      child.once("error", reject); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
    report.close = exit; report.stdout = stdout; report.stderr = stderr;
    if (exit.code !== 0 || !fs.existsSync(childResult)) throw new Error("OWNED_POLICY_PROBE_CHILD_FAILED");
    report.result = JSON.parse(fs.readFileSync(childResult, "utf8")); assert.equal(report.result.passed, true);
    report.status = "passed";
  } catch (error) { report.errorCode = error.code ?? error.message; report.status = child ? "failed" : "blocked"; process.exitCode = 1; }
  finally {
    if (child && child.exitCode === null && !child.signalCode) {
      const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      child.kill("SIGTERM"); report.cleanupClose = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
    }
    report.ownedChildClosed = !child || child.exitCode !== null || Boolean(child.signalCode);
    report.installedAfter = fingerprints(); report.installedUnchanged = JSON.stringify(report.installedBefore) === JSON.stringify(report.installedAfter);
    if (!report.ownedChildClosed || !report.installedUnchanged) { report.status = "failed"; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ status: report.status, output, root: report.root, errorCode: report.errorCode ?? null,
    providerCalls: 0, installedUnchanged: report.installedUnchanged, ownedChildClosed: report.ownedChildClosed }) + "\n");
}
if (require.main === module) (process.argv[2] === "--owned-child" ? childMain(process.argv[3]) : main()).catch(error => {
  process.stderr.write(JSON.stringify({ errorCode: error.code ?? error.message }) + "\n"); process.exitCode = 1;
});
module.exports = { reserve };
