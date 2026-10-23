#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");
const { spawn } = require("node:child_process");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexSchemaContract, CODEX_VERSION } = require("../app/agent-service/codex-schema-contract");
const { RuntimeAccountResolver, defaultRuntimeAccountLookup } = require("../app/agent-service/runtime-account-resolver");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { resolveCodexRuntimeLayout } = require("../app/agent-service/codex-runtime-paths");
const { namedPermissionConfig, ownedShellEnvironmentConfig, boundedLocalFeatureConfig, assertOwnedFeatureInventory,
  permissionConfigArgs, wrapOwnedPermissionHost } = require("./codex-owned-permissions-fixture.cjs");
const REPO = path.resolve(__dirname, ".."), MAIN = process.env.SHOGGOTH_TEST_RUNTIME_REPO || REPO;
const EXPECTED_BINARY_SHA = "16593cc2f422d5f398a8e40f550ebbaf1245392528957be342c295920a300704";
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const beforeSource = Object.fromEntries(["app/agent-service/codex-runtime-host.js", "app/agent-service/codex-runtime-adapter.js", "app/agent-service/codex-schema-contract.js"].map(relative => [relative, hash(path.join(REPO, relative))]));
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sgcodex-permissions-native-")); fs.chmodSync(root, 0o700);
const home = path.join(root, "home"), work = path.join(root, "workspace");
for (const directory of [home, work]) fs.mkdirSync(directory, { mode: 0o700 });
const canary = path.join(home, "private-canary.txt"), canaryBody = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(canary, canaryBody, { mode: 0o600 }); const canaryBefore = hash(canary);
const escape = path.join(work, "escape-link"); fs.symlinkSync(home, escape);
const paths = resolveServicePaths({ homeDir: home, userDataRoot: path.join(root, "app"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
const parentEnv = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: path.join(root, "temp") }; fs.mkdirSync(parentEnv.TMPDIR, { mode: 0o700 });
const binding = { runtime: "codex", runtimeProfileId: "owned-permissions-probe", runtimeAccountId: "shoggoth-internal-codex-default-v1" };
const environment = new RuntimeAccountResolver({ paths, homedir: home, parentEnv, repoRoot: MAIN }).resolve(binding, defaultRuntimeAccountLookup(binding.runtimeAccountId));
const binary = resolveCodexRuntimeLayout({ repoRoot: MAIN }).runtimePath;
assert.equal(hash(binary), EXPECTED_BINARY_SHA); assert.equal(environment.binaryPath, binary);
const forbiddenStarted = path.join(root, "forbidden-mcp-started");
const legacyGlobal = process.argv.includes("--legacy-global");
const appSentinel = crypto.randomBytes(32).toString("hex"), configSentinel = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(path.join(environment.home, "config.toml"), (legacyGlobal ? 'sandbox_mode="danger-full-access"\n' : '') +
  '[shell_environment_policy]\ninherit="all"\n[shell_environment_policy.set]\nSHOGGOTH_EVALUATION_CONFIG_SENTINEL=' + JSON.stringify(configSentinel) + "\n" +
  "[mcp_servers.forbidden_fixture]\ncommand=\"/usr/bin/touch\"\nargs=[" + JSON.stringify(forbiddenStarted) + "]\nenabled=true\n", { mode: 0o600 });
const config = { ...namedPermissionConfig({ workspace: work, disabledMcpNames: ["forbidden_fixture"] }),
  ...ownedShellEnvironmentConfig({ tempDirectory: parentEnv.TMPDIR, inheritedSetNames: ["SHOGGOTH_EVALUATION_CONFIG_SENTINEL"] }) };
const outgoing = [], rawReplies = [], wrapEvidence = [], checks = [], diagnostics = [], rpcErrors = [];
const requestMethods = new Map();
let host, child, closeReceipt, networkHits = 0, server, rawSentinelLeak = false;
let report = { reportVersion: 1, status: "failed", root, checks, providerCalls: 0, modelTurns: 0,
  originalLegacySandboxReproduced: legacyGlobal,
  binary: { path: binary, version: CODEX_VERSION, sha256: EXPECTED_BINARY_SHA }, sourceBefore: beforeSource,
  boundary: "pinned-official-appserver-no-auth-no-model-no-original-config;controlled-command-exec-only" };
async function command(label, argv) {
  const reply = await host.rpc.request("command/exec", { command: argv, cwd: work, timeoutMs: 5000, outputBytesCap: 4096 }, { timeoutMs: 10000 });
  assert(Number.isInteger(reply.exitCode)); rawReplies.push({ label, command: argv, ...reply }); return reply;
}
function check(label, value) { checks.push({ label, passed: Boolean(value) }); assert(value, label); }
async function featuresFor(threadId = null) {
  const data = [], cursors = new Set(); let cursor = null;
  do {
    const page = await host.experimentalFeatureList({ cursor, limit: 100, ...(threadId ? { threadId } : {}) });
    assert(Array.isArray(page.data)); data.push(...page.data); assert(data.length <= 2048);
    cursor = page.nextCursor ?? null;
    if (cursor) { assert(!cursors.has(cursor)); cursors.add(cursor); }
  } while (cursor);
  return data;
}
(async () => {
  try {
    server = http.createServer((req, res) => { networkHits += 1; res.end("network-canary"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    host = new CodexRuntimeHost({ repoRoot: REPO, paths, runtimeBinding: binding, runtimeEnvironment: environment, cwd: work, parentEnv,
      homedir: home, schemaContract: new CodexSchemaContract({ repoRoot: REPO }), requestTimeoutMs: 10000,
      prepareRuntime: async () => ({ spawnEnv: { SHOGGOTH_EVALUATION_APP_SENTINEL: appSentinel }, registeredSecrets: [configSentinel], configArgs: permissionConfigArgs(config) }),
      onDiagnostic: item => diagnostics.push(item.code),
      spawnProcess(command, args, options) {
        assert.equal(command, binary); assert.equal(options.env.HOME, home); assert.equal(options.env.CODEX_HOME, environment.home);
        assert.equal(options.env.SHOGGOTH_EVALUATION_APP_SENTINEL, appSentinel);
        for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CHATGPT_ACCESS_TOKEN", "HTTPS_PROXY"]) assert.equal(options.env[key], undefined);
        child = spawn(command, args, options); const write = child.stdin.write.bind(child.stdin);
        let frames = "";
        child.stdout.on("data", bytes => { frames += bytes.toString(); for (let end; (end = frames.indexOf("\n")) >= 0;) {
          const line = frames.slice(0, end); frames = frames.slice(end + 1); const frame = JSON.parse(line);
          if (frame.error) rpcErrors.push({ id: frame.id, code: frame.error.code, message: frame.error.message });
          if (requestMethods.get(frame.id) === "command/exec" && (line.includes(appSentinel) || line.includes(configSentinel))) rawSentinelLeak = true;
        } });
        child.stdin.write = (chunk, ...rest) => { const frame = JSON.parse(String(chunk)); outgoing.push({ method: frame.method ?? null, id: frame.id ?? null });
          if (frame.method && frame.id !== undefined) requestMethods.set(frame.id, frame.method); return write(chunk, ...rest); };
        child.once("close", (code, signal) => { closeReceipt = { pid: child.pid, code, signal }; }); return child;
      } });
    wrapOwnedPermissionHost(host, config, wrapEvidence);
    await host.initialize(); check("exact pinned Runtime", host.runtimeVersion === CODEX_VERSION);
    const featureInventory = await featuresFor();
    report.initialFeatureInventory = featureInventory.map(item => ({ name: item.name, enabled: item.enabled }));
    Object.assign(config, boundedLocalFeatureConfig(featureInventory, { allowShell: true }));
    report.featureInventoryCount = featureInventory.length;
    const effective = await host.configRead({ includeLayers: false, cwd: work });
    report.effectiveConfig = { defaultPermissions: effective.config.default_permissions ?? null,
      permissions: effective.config.permissions ?? null, sandboxMode: effective.config.sandbox_mode ?? null,
      tools: effective.config.tools ?? null, mcp: effective.config.mcp_servers ?? null,
      shellEnvironmentPolicy: effective.config.shell_environment_policy ?? null };
    check("actual config selects named profile", effective.config.default_permissions === config.default_permissions);
    const started = await host.threadStart({ cwd: work, ephemeral: false, approvalPolicy: "on-request", sandbox: "workspace-write" });
    report.threadStart = { id: started.thread.id, sandbox: started.sandbox, approvalPolicy: started.approvalPolicy,
      cwd: started.cwd, model: started.model, modelProvider: started.modelProvider,
      activePermissionProfile: started.activePermissionProfile ?? null, runtimeWorkspaceRoots: started.runtimeWorkspaceRoots ?? null,
      additionalFields: Object.keys(started).filter(key => !["thread", "model", "modelProvider", "serviceTier", "disabledPluginIds", "cwd", "instructionSources", "approvalPolicy", "approvalsReviewer", "sandbox", "reasoningEffort"].includes(key)) };
    // Append one fixed control item to persist the newly created native thread;
    // this does not request inference or execute any model-selected tool.
    await host.threadInjectItems({ threadId: started.thread.id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "controlled permission probe; do not run a model" }] }] });
    report.controlHistoryInjected = true;
    const resumed = await host.threadResume({ threadId: started.thread.id, cwd: work, excludeTurns: true, approvalPolicy: "on-request", sandbox: "workspace-write" });
    report.threadResume = { id: resumed.thread.id, sandbox: resumed.sandbox, model: resumed.model, modelProvider: resumed.modelProvider, activePermissionProfile: resumed.activePermissionProfile ?? null };
    check("actual threads select the named profile", started.activePermissionProfile?.id === config.default_permissions && resumed.activePermissionProfile?.id === config.default_permissions);
    check("threadStart and threadResume remove only legacy sandbox", wrapEvidence.length === 2 && wrapEvidence.every(row => row.removedLegacySandbox === "workspace-write" && row.modelProvided === false));
    const inventory = await host.mcpServerStatusList({ threadId: started.thread.id, limit: 100, detail: "toolsAndAuthOnly" });
    report.mcpInventory = inventory.data.map(item => ({ name: item.name, runtimeStatus: item.runtimeStatus, toolNames: Object.keys(item.tools ?? {}) }));
    check("other MCP remains noncallable and unstarted", !inventory.nextCursor && inventory.data.every(item => item.runtimeStatus === "disabled" && Object.keys(item.tools ?? {}).length === 0) && !fs.existsSync(forbiddenStarted));
    const features = await featuresFor(started.thread.id), resumedFeatures = await featuresFor(resumed.thread.id);
    report.features = features.map(item => ({ name: item.name, enabled: item.enabled }));
    check("actual thread execution features permit only bounded shell", assertOwnedFeatureInventory(features, { allowShell: true }) && assertOwnedFeatureInventory(resumedFeatures, { allowShell: true }));
    const shellEnvironment = await command("shell-environment", ["/usr/bin/env"]);
    report.syntheticEnvironment = { appServerSentinelInjected: true, inheritedConfigSentinelInjected: true,
      inheritedMode: "all", rawCommandSentinelLeak: rawSentinelLeak,
      inheritedAppKeyVisible: /SHOGGOTH_EVALUATION_APP_SENTINEL=/.test(shellEnvironment.stdout),
      inheritedConfigValueCleared: shellEnvironment.stdout.includes("SHOGGOTH_EVALUATION_CONFIG_SENTINEL=\n") };
    check("shell environment drops app and configured synthetic secrets before Host redaction", shellEnvironment.exitCode === 0 && !rawSentinelLeak && !report.syntheticEnvironment.inheritedAppKeyVisible && report.syntheticEnvironment.inheritedConfigValueCleared);
    check("shell environment has only fixed paths and locale", shellEnvironment.stdout.includes("PATH=/usr/bin:/bin\n") && shellEnvironment.stdout.includes("TMPDIR=" + parentEnv.TMPDIR + "\n") && shellEnvironment.stdout.includes("LANG=C.UTF-8\n"));
    const artifact = path.join(work, "sum-valid.cjs"), body = "module.exports = values => values.reduce((s,x) => s + (typeof x === 'number' && Number.isFinite(x) ? x : 0),0);";
    check("owned artifact write allowed", (await command("owned-write", ["/bin/sh", "-c", "printf '%s' " + quote(body) + " > " + quote(artifact)])).exitCode === 0);
    check("owned artifact read allowed", (await command("owned-read", ["/bin/cat", artifact])).stdout === body);
    const direct = await command("outside-private-read", ["/bin/cat", canary]);
    check("outside private canary read denied", direct.exitCode !== 0 && !direct.stdout.includes(canaryBody));
    const outside = await command("outside-private-write", ["/bin/sh", "-c", "printf '%s' 'changed' > '" + canary + "'"]);
    check("outside private canary write denied", outside.exitCode !== 0 && hash(canary) === canaryBefore);
    const link = await command("symlink-private-read", ["/bin/cat", path.join(escape, "private-canary.txt")]);
    check("symlink escape read denied", link.exitCode !== 0 && !link.stdout.includes(canaryBody));
    const linkWrite = await command("symlink-private-write", ["/bin/sh", "-c", "printf '%s' 'changed' > '" + path.join(escape, "private-canary.txt") + "'"]);
    check("symlink escape write denied", linkWrite.exitCode !== 0 && hash(canary) === canaryBefore);
    const network = await command("network-denied", ["/usr/bin/curl", "--max-time", "2", "--noproxy", "*", "http://127.0.0.1:" + server.address().port + "/canary"]);
    check("network denied and local server receives no request", network.exitCode !== 0 && networkHits === 0);
    Object.assign(config, boundedLocalFeatureConfig(featureInventory, { allowShell: false }));
    const observerThread = await host.threadStart({ cwd: work, ephemeral: true, approvalPolicy: "on-request", sandbox: "read-only" });
    const observerFeatures = await featuresFor(observerThread.thread.id);
    report.noShellThread = { activePermissionProfile: observerThread.activePermissionProfile,
      features: observerFeatures.map(item => ({ name: item.name, enabled: item.enabled })) };
    check("nonimplementation thread disables every model execution feature", assertOwnedFeatureInventory(observerFeatures, { allowShell: false }));
    check("no model or login RPC dispatched", !outgoing.some(frame => /^(?:turn\/|account\/login|account\/chatgptAuthTokens)/.test(frame.method ?? "")));
    report.status = "passed"; report.canaryUnchanged = hash(canary) === canaryBefore; report.artifactSha256 = hash(artifact);
  } catch (error) { report.error = { code: error.code ?? null, rpcCode: error.rpcCode ?? null, classification: error.remoteClassification ?? null, message: error.message }; process.exitCode = 1; }
  finally {
    try { await host?.stop(); } catch (error) { report.cleanupError = error.code ?? error.message; report.status = "failed"; process.exitCode = 1; }
    await new Promise(resolve => server?.close(resolve));
    report.closeReceipt = closeReceipt ?? null; report.ownedRuntimeClosed = Boolean(closeReceipt);
    report.rawCommandReplies = rawReplies; report.rpcMethods = outgoing; report.rpcErrors = rpcErrors; report.wrapperEvidence = wrapEvidence; report.diagnostics = diagnostics;
    report.rawCommandSentinelLeak = rawSentinelLeak;
    report.networkHits = networkHits; report.sourceAfter = Object.fromEntries(Object.keys(beforeSource).map(relative => [relative, hash(path.join(REPO, relative))]));
    report.sourceUnchanged = JSON.stringify(beforeSource) === JSON.stringify(report.sourceAfter);
    if (!report.sourceUnchanged || !report.ownedRuntimeClosed) { report.status = "failed"; process.exitCode = 1; }
    const output = path.join(root, "result.json"); fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: report.status, root, output, error: report.error ?? null,
      passedChecks: checks.filter(row => row.passed).length, providerCalls: 0, modelTurns: 0, sourceUnchanged: report.sourceUnchanged, ownedRuntimeClosed: report.ownedRuntimeClosed }) + "\n");
  }
})().catch(error => { process.stderr.write(String(error.stack) + "\n"); process.exitCode = 1; });
