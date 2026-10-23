#!/usr/bin/env node
"use strict";

// Pinned official Runtime, synthetic Home and scripted loopback Responses.
// This proves native context/tool/approval behavior; it is not real Model or L3
// acceptance. No original Home, auth, config or account is copied or opened.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexSchemaContract, CODEX_VERSION } = require("../app/agent-service/codex-schema-contract");
const { RuntimeAccountResolver, defaultRuntimeAccountLookup } = require("../app/agent-service/runtime-account-resolver");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { resolveCodexRuntimeLayout } = require("../app/agent-service/codex-runtime-paths");
const { NativeCodexAuth } = require("../app/agent-service/codex-native-auth");
const { namedPermissionConfig, ownedShellEnvironmentConfig, ownedContextConfig, boundedLocalFeatureConfig, assertOwnedFeatureInventory,
  permissionConfigArgs, wrapOwnedPermissionHost } = require("./codex-owned-permissions-fixture.cjs");
const REPO = path.resolve(__dirname, ".."), MAIN = process.env.SHOGGOTH_TEST_RUNTIME_REPO || REPO;
const BINARY_SHA = "16593cc2f422d5f398a8e40f550ebbaf1245392528957be342c295920a300704";
const useContextKernel = !process.argv.includes("--no-context-kernel");
const serviceName = process.argv.find(arg => arg.startsWith("--service-name="))?.slice("--service-name=".length) ?? null;
const privateContextFixtures = !process.argv.includes("--without-private-context");
const borrowedAuth = process.argv.includes("--borrowed-auth");
const capabilityCanaries = process.argv.includes("--capability-canaries");
const interruptCanary = process.argv.includes("--interrupt-canary");
const scenarioNames = new Set(["context", "code", "approval", "denied", "patch-ro", "patch-rw", "agent-list", "agent-spawn", "agent-message", "agent-followup", "agent-interrupt", "agent-wait"]);
function scenarioOf(body) { const name = /OWNED_SCENARIO=([a-z-]+)/.exec(JSON.stringify(body.input))?.[1]; assert(scenarioNames.has(name)); return name; }
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function freeSpace() { const stat = fs.statfsSync("/private/tmp"); return stat.bavail * stat.bsize; }
assert(freeSpace() >= 1024 ** 3, "minimum 1 GiB available before owned SDK stage");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sgcodex-context-approval-")); fs.chmodSync(root, 0o700);
const home = path.join(root, "home"), work = path.join(root, "workspace"), temp = path.join(root, "temp");
for (const directory of [home, work, temp]) fs.mkdirSync(directory, { mode: 0o700 });
const nativeSourceHome = borrowedAuth ? path.join(home, ".codex") : null;
if (borrowedAuth) fs.mkdirSync(nativeSourceHome, { mode: 0o700 });
const paths = resolveServicePaths({ homeDir: home, userDataRoot: path.join(root, "app"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
const parentEnv = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: temp,
  ...(borrowedAuth ? { CODEX_HOME: nativeSourceHome, NO_PROXY: "127.0.0.1,localhost" } : {}) };
const binding = { runtime: "codex", runtimeProfileId: "owned-context-approval", runtimeAccountId: "shoggoth-internal-codex-default-v1" };
const environment = new RuntimeAccountResolver({ paths, homedir: home, parentEnv, repoRoot: MAIN }).resolve(binding, defaultRuntimeAccountLookup(binding.runtimeAccountId));
const binary = resolveCodexRuntimeLayout({ repoRoot: MAIN }).runtimePath; assert.equal(hash(binary), BINARY_SHA);
const privateMarker = "OWNED_PRIVATE_CONTEXT_" + crypto.randomBytes(16).toString("hex");
const syntheticAccountId = "owned-fixture-account";
const encodeJwt = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const syntheticToken = borrowedAuth ? encodeJwt({ alg: "RS256" }) + "." + encodeJwt({ exp: Math.floor(Date.now() / 1000) + 3600,
  email: "owned-fixture@example.test", "https://api.openai.com/auth": { chatgpt_account_id: syntheticAccountId, chatgpt_plan_type: "plus" } })
  + "." + Buffer.from("synthetic-signature-" + crypto.randomBytes(16).toString("hex")).toString("base64url") : crypto.randomBytes(32).toString("hex");
const fixedBase = "OWNED_SYNTHETIC_NATIVE_BASE: You are a fixture in an isolated Shoggoth native group collaboration test. Task facts and output are controlled synthetic data. Use only the available tool and the exact supplied command. Never read another Home or credential.";
const fixedDeveloper = "OWNED_SYNTHETIC_GROUP_ROLE: Follow the current synthetic request and preserve the fixed descriptor.";
const fixedInstructions = path.join(root, "fixed-instructions.txt"), privateInstructions = path.join(root, "private-instructions.txt");
fs.writeFileSync(fixedInstructions, fixedBase, { mode: 0o600 }); fs.writeFileSync(privateInstructions, privateMarker, { mode: 0o600 });
if (privateContextFixtures) for (const target of [path.join(home, "AGENTS.md"), path.join(borrowedAuth ? nativeSourceHome : environment.home, "AGENTS.md"), path.join(work, "AGENTS.md")])
  fs.writeFileSync(target, privateMarker, { mode: 0o600 });
const skillPaths = [path.join(borrowedAuth ? nativeSourceHome : environment.home, "skills", "owned-private-skill", "SKILL.md"), path.join(home, ".agents", "skills", "owned-host-skill", "SKILL.md")];
if (privateContextFixtures) for (const target of skillPaths) { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, "---\nname: owned-private-skill\ndescription: " + privateMarker + "\n---\n" + privateMarker + "\n", { mode: 0o600 }); }
const memories = path.join(borrowedAuth ? nativeSourceHome : environment.home, "memories"); fs.mkdirSync(memories, { mode: 0o700 });
if (privateContextFixtures) for (const name of ["memory_summary.md", "MEMORY.md"]) fs.writeFileSync(path.join(memories, name), privateMarker, { mode: 0o600 });
const notifyMarker = path.join(root, "forbidden-notify"), outside = path.join(home, "private-canary.txt");
fs.writeFileSync(outside, privateMarker, { mode: 0o600 }); const outsideBefore = hash(outside);
const proof = path.join(work, "approval-proof.txt"), denied = path.join(home, "must-not-create.txt");
const readonlyPatch = path.join(work, "readonly-patch-proof.txt"), writablePatch = path.join(work, "writable-patch-proof.txt"), outsidePatch = path.join(home, "outside-patch-proof.txt");
const exactCommand = "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'";
const deniedCommand = "printf '%s' 'forbidden' > '" + denied + "'";
const contextRoots = [path.join(environment.home, "skills"), path.join(environment.home, "memories"), path.join(home, ".agents", "skills")];
const contextFiles = [path.join(home, "AGENTS.md"), path.join(environment.home, "AGENTS.md"), path.join(work, "AGENTS.md")];
const kernelProfile = path.join(root, "context-only-denial.sb");
const kernelText = "(version 1)\n(allow default)\n(deny file-read* " + contextFiles.flatMap(file => [file, "/System/Volumes/Data" + file]).map(file => "(literal " + JSON.stringify(file) + ")").join(" ")
  + " " + contextRoots.flatMap(file => [file, "/System/Volumes/Data" + file]).map(file => "(subpath " + JSON.stringify(file) + ")").join(" ") + ")\n";
fs.writeFileSync(kernelProfile, kernelText, { mode: 0o600 });
const sourceFiles = ["app/agent-service/codex-runtime-host.js", "app/agent-service/codex-runtime-adapter.js", "app/agent-service/codex-schema-contract.js", "app/agent-service/codex-native-auth.js", "scripts/codex-owned-permissions-fixture.cjs", "scripts/codex-owned-context-approval-native-fixture.cjs"];
const beforeSource = Object.fromEntries(sourceFiles.map(relative => [relative, hash(path.join(REPO, relative))]));
const requests = [], approvals = [], checks = [], rpcMethods = [], events = [], completed = new Map(), errors = [];
const wrapperEvidence = []; let host, child, closeReceipt, provider, tlsProvider, serverFailure, activeThread = null, activeTurn = null, currentScenario = null;
let listedAgentTarget = null;
let nativeAuth, nativeSourceBefore = null;
const authChildren = [], authCloseReceipts = [], authRpcMethods = [], routingRequests = [], metadataRequests = [];
const authSourceErrors = [], authReadFailures = [];
const nativeSdkSymlinks = [];
let nativeTokenObservedOutsideAccountRpc = false, nativeTokenObservedInSpawnEnv = false, borrowedAccountLoginIdentityMatched = false;
const nativeWireErrors = [];
const config = { ...namedPermissionConfig({ workspace: work, writable: false }),
  ...ownedShellEnvironmentConfig({ tempDirectory: temp }), ...ownedContextConfig({ instructionsFile: fixedInstructions, disabledSkillPaths: skillPaths }) };
let report = { reportVersion: 1, status: "failed", root, checks, requests, approvals,
  privateContextFixtures, useContextKernel, serviceName, capabilityCanaries, interruptCanary, borrowedAuth,
  realProviderCalls: 0, remoteModelCalls: 0, controlledLocalTurns: 0, sourceBefore: beforeSource,
  binary: { path: binary, version: CODEX_VERSION, sha256: BINARY_SHA },
  boundary: "pinned-native-runtime-local-responses-controlled-output;synthetic-home-only;not-L3" };
function check(label, value) { checks.push({ label, passed: Boolean(value) }); assert(value, label); }
function ownedProcesses() {
  const ownedPids = new Set([child?.pid, ...authChildren.map(item => item.pid)].filter(Boolean));
  if (ownedPids.size === 0) return [];
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" }).split("\n")
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), executable: match[4] }));
  return rows.filter(row => ownedPids.has(row.pgid) || ownedPids.has(row.pid));
}
function ownedHandlePids() {
  try {
    const lines = execFileSync("/usr/sbin/lsof", ["-nP", "-Fp", "+D", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n");
    return [...new Set(lines.filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))].filter(pid => pid !== process.pid);
  } catch (error) {
    if (error.status === 1 && (!error.stdout || String(error.stdout).trim() === "")) return [];
    throw error;
  }
}
function tokenFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...tokenFiles(file));
    else if (entry.isFile()) {
      assert(fs.statSync(file).size <= 32 * 1024 * 1024, "owned fixture token scan has a bounded file size");
      if (fs.readFileSync(file).includes(Buffer.from(syntheticToken))) found.push(file);
    } else if (entry.isSymbolicLink()) {
      // The real CLI creates temporary PATH aliases to its own pinned public
      // executable. Inspect exact identity; never follow a private target.
      const target = fs.realpathSync(file);
      nativeSdkSymlinks.push({ path: file, target });
      assert(target === fs.realpathSync(binary) && hash(target) === BINARY_SHA,
        "owned fixture token scan only permits exact pinned public SDK aliases: " + file);
    }
  }
  return found;
}
async function waitFor(condition, timeoutMs = 15000, label = "owned native completion") {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) { if (serverFailure) throw serverFailure; assert(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function flattenTools(items, namespace = null) {
  return (items ?? []).flatMap(item => item.tools ? flattenTools(item.tools, item.name)
    : [{ ...item, ...(namespace ? { namespace } : {}) }]);
}
async function featureInventory(threadId = null) {
  const features = [], seen = new Set(); let cursor = null;
  do { const page = await host.experimentalFeatureList({ cursor, limit: 100, ...(threadId ? { threadId } : {}) });
    assert(Array.isArray(page.data)); features.push(...page.data); assert(features.length <= 2048);
    cursor = page.nextCursor ?? null; if (cursor) { assert(!seen.has(cursor)); seen.add(cursor); }
  } while (cursor); return features;
}
function commandMatches(actual, expected) {
  if (actual === expected) return true;
  if (actual === "/bin/zsh -c " + JSON.stringify(expected)) return true;
  if (typeof actual !== "string" || !actual.startsWith("[")) return false;
  let argv; try { argv = JSON.parse(actual); } catch { return false; }
  return Array.isArray(argv) && argv.length === 3 && ["/bin/sh", "/bin/zsh", "/bin/bash", "sh", "zsh", "bash"].includes(argv[0])
    && argv[1] === "-c" && argv[2] === expected;
}
function responseItem(body, number) {
  const outputs = (body.input ?? []).filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
  const scenario = scenarioOf(body);
  if (outputs.length || scenario === "context") return { id: "message-" + number, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "CONTROLLED_" + scenario.toUpperCase() + "_COMPLETE", annotations: [] }] };
  const tools = flattenTools([...(body.tools ?? []), ...(body.input ?? []).filter(item => item.type === "additional_tools").flatMap(item => item.tools ?? [])]);
  const exec = tools.find(item => item.name === "exec" && item.type === "custom");
  if (scenario.startsWith("patch-")) {
    assert(exec, "native code-mode route must execute actual apply_patch primitive");
    const destination = scenario === "patch-ro" ? readonlyPatch : writablePatch;
    const patch = file => "*** Begin Patch\n*** Add File: " + file + "\n+owned-patch-evidence-v1\n*** End Patch";
    return { id: "patch-" + number, type: "custom_tool_call", call_id: "owned-patch-" + number, name: "exec",
      ...(exec.namespace ? { namespace: exec.namespace } : {}),
      input: "text('OWNED_APPLY_PATCH_GUEST_RAN');for(const patch of " + JSON.stringify([patch(destination), patch(outsidePatch)])
        + "){try{text(await tools.apply_patch(patch));}catch(e){text({applyPatchBlocked:String(e)});}}" };
  }
  if (scenario.startsWith("agent-")) {
    const name = { "agent-list": "list_agents", "agent-spawn": "spawn_agent", "agent-message": "send_message", "agent-followup": "followup_task", "agent-interrupt": "interrupt_agent", "agent-wait": "wait_agent" }[scenario];
    const tool = tools.find(item => item.namespace === "collaboration" && item.name === name); assert(tool, "actual native collaboration tool must be present");
    const args = scenario === "agent-list" ? {} : scenario === "agent-wait" ? { timeout_ms: 10000 } : scenario === "agent-spawn"
      ? { task_name: "owned_capability_probe", message: "OWNED_FORBIDDEN_AGENT_CHILD: no real model request is permitted.", fork_turns: "none" }
      : scenario === "agent-interrupt" ? { target: listedAgentTarget }
      : { target: listedAgentTarget, message: "OWNED_FORBIDDEN_CROSS_AGENT_MESSAGE" };
    assert(["agent-list", "agent-wait", "agent-spawn"].includes(scenario) || typeof listedAgentTarget === "string");
    return { id: "agent-" + number, type: "function_call", call_id: "owned-agent-" + number, name,
      namespace: "collaboration", arguments: JSON.stringify(args), status: "completed" };
  }
  if (scenario === "code") {
    assert(exec, "native code-mode tool must be present for ambient negative proof");
    const code = "text({ambient:{process:typeof process,require:typeof require,fetch:typeof fetch},toolNames:typeof ALL_TOOLS==='undefined'?null:ALL_TOOLS.map(t=>t.name)});"
      + "text('OWNED_CODE_GUEST_RAN');"
      + "try { const fs=await import('node:fs');text({parentReadableConfig:fs.readFileSync(" + JSON.stringify(path.join(environment.home, "config.toml")) + ", 'utf8')}); }catch(e){text({fsBlocked:String(e)});}"
      + "try{text({parentEnvironment:process.env.SHOGGOTH_OWNED_FIXTURE_TOKEN});}catch(e){text({envBlocked:String(e)});}";
    return { id: "code-" + number, type: "custom_tool_call", call_id: "owned-code-" + number, name: "exec",
      ...(exec.namespace ? { namespace: exec.namespace } : {}), input: code };
  }
  const tool = tools.find(item => ["exec_command", "shell_command", "shell"].includes(item.name));
  const command = scenario === "approval" ? exactCommand : deniedCommand;
  if (!tool) {
    assert(exec, "native shell tool or bounded code-mode route must be exposed for approval fixture");
    return { id: "tool-" + number, type: "custom_tool_call", call_id: "owned-call-" + number, name: "exec",
      ...(exec.namespace ? { namespace: exec.namespace } : {}), input: "text(await tools.exec_command(" + JSON.stringify({ cmd: command, workdir: work,
        login: false, sandbox_permissions: "require_escalated", justification: "Synthetic exact descriptor approval proof" }) + "));" };
  }
  const args = tool.name === "exec_command" ? { cmd: command, workdir: work, login: false, sandbox_permissions: "require_escalated", justification: "Synthetic exact descriptor approval proof" }
    : { command, workdir: work, login: false, sandbox_permissions: "require_escalated", justification: "Synthetic exact descriptor approval proof" };
  return { id: "tool-" + number, type: "function_call", call_id: "owned-call-" + number, name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args), status: "completed" };
}
async function controlledTurn(scenario, allFeatures, allowShell) {
  currentScenario = scenario; activeTurn = null;
  // Implementation approval must retain scoped SDK file capability. A named
  // read-only profile correctly continues denying the write after accept.
  Object.assign(config, namedPermissionConfig({ workspace: work,
    writable: scenario === "approval" || scenario === "denied" || scenario === "patch-rw" }));
  Object.assign(config, boundedLocalFeatureConfig(allFeatures, { allowShell }));
  // Only the synthetic context target is persisted, because the pinned SDK
  // rejects turns/list for ephemeral threads. This allows native terminal
  // evidence before any optional control canary; all storage is in owned Home.
  const started = await host.threadStart({ cwd: work, ephemeral: scenario !== "context", approvalPolicy: "on-request", sandbox: "read-only", developerInstructions: fixedDeveloper,
    ...(serviceName ? { serviceName } : {}) });
  activeThread = started.thread.id;
  assertOwnedFeatureInventory(await featureInventory(activeThread), { allowShell });
  report.threads ??= []; report.threads.push({ scenario, id: activeThread, sandbox: started.sandbox,
    activePermissionProfile: started.activePermissionProfile, instructionSources: started.instructionSources,
    model: started.model, modelProvider: started.modelProvider });
  const result = await host.turnStart({ threadId: activeThread, clientUserMessageId: "owned-" + scenario,
    input: [{ type: "text", text: "OWNED_SCENARIO=" + scenario + "\nFixed synthetic request only.\n" + (scenario === "approval" ? exactCommand : scenario === "denied" ? deniedCommand : "Reply with controlled context proof."), text_elements: [] }], cwd: work });
  activeTurn = result.turn.id; report.controlledLocalTurns += 1;
  await waitFor(() => completed.has(activeTurn), 15000, "controlled native " + scenario + " turn must complete");
  check("native " + scenario + " turn completed", completed.get(activeTurn) === "completed");
  const scenarioRequests = requests.filter(item => item.scenario === scenario);
  check("native " + scenario + " request uses fixed synthetic base and role", scenarioRequests.length > 0 && scenarioRequests.every(item => item.fixedBasePresent && item.fixedRolePresent && !item.privateContextPresent));
  report.actualToolClosure = scenarioRequests.every(item => item.toolNames.every(name =>
    ["exec_command", "write_stdin", "shell_command", "shell", "apply_patch", "request_user_input", "request_user_input_async"].includes(name)));
}
(async () => {
  try {
    const localRequestHandler = (req, res) => { const chunks = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      try {
        if (borrowedAuth && req.url !== "/v1/responses") {
          const route = new URL(req.url, "http://127.0.0.1").pathname;
          if (req.method === "GET" && ["/wham/accounts/check", "/api/codex/accounts/check"].includes(route)) {
            routingRequests.push({ method: req.method, path: route, identityMatched: req.headers.authorization === "Bearer " + syntheticToken });
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ accounts: [{ id: syntheticAccountId,
              plan_type: "plus", workspace_backend_origin: "https://127.0.0.1:" + tlsProvider.address().port,
              account_routing_override: "NO_CONSTRAINT" }] })); return;
          }
          if ((req.method === "GET" && ["/plugins/featured", "/ps/plugins/installed", "/ps/plugins/list", "/ps/plugins/suggested/codex", "/v1/models", "/api/codex/settings/user"].includes(route))
            || (req.method === "POST" && ["/api/codex/ps/mcp", "/codex/analytics-events/events"].includes(route))) {
            metadataRequests.push({ method: req.method, path: route, response: 404 }); res.writeHead(404).end(); return;
          }
          throw new Error("undeclared owned local metadata route: " + req.method + " " + route);
        }
        assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/responses");
        assert.equal(req.headers.authorization, "Bearer " + syntheticToken);
        const bytes = Buffer.concat(chunks), body = JSON.parse(bytes), number = requests.length + 1;
        const tools = flattenTools([...(body.tools ?? []), ...(body.input ?? []).filter(item => item.type === "additional_tools").flatMap(item => item.tools ?? [])]);
        const text = bytes.toString(), scenario = scenarioOf(body);
        assert(!text.includes(syntheticToken), "synthetic borrowed token never enters model request JSON or tool body");
        const requestRecord = { sequence: number, scenario, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
          model: body.model, fixedBasePresent: text.includes(fixedBase), fixedRolePresent: text.includes(fixedDeveloper),
          privateContextPresent: text.includes(privateMarker), tokenPresentInBody: false, toolNames: [...new Set(tools.map(tool => tool.name))].sort(), payload: body };
        requests.push(requestRecord); assert(!requestRecord.privateContextPresent, "no synthetic private context reaches local model request");
        const item = responseItem(body, number), id = "owned-response-" + number; res.writeHead(200, { "Content-Type": "text/event-stream" });
        let sequence = 0; const event = (type, data) => res.write("event: " + type + "\ndata: " + JSON.stringify({ type, sequence_number: sequence++, ...data }) + "\n\n");
        event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
        event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
        event("response.output_item.done", { output_index: 0, item });
        event("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
      } catch (error) { serverFailure = error; res.writeHead(500); res.end("controlled fixture failure"); }
    }); };
    provider = http.createServer(localRequestHandler);
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    if (borrowedAuth) {
      const cert = path.join(root, "owned-loopback-ca.crt"), key = path.join(root, "owned-loopback-ca.key"), opensslConfig = path.join(root, "owned-loopback-ca.conf");
      fs.writeFileSync(opensslConfig, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
      execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-config", opensslConfig], { stdio: "ignore" });
      fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
      parentEnv.SSL_CERT_FILE = cert; parentEnv.CODEX_CA_CERTIFICATE = cert;
      tlsProvider = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, localRequestHandler);
      await new Promise(resolve => tlsProvider.listen(0, "127.0.0.1", resolve));
      const sourceAuthPath = path.join(nativeSourceHome, "auth.json");
      // This is the intentionally seeded synthetic source credential fixture.
      // The execution Home must never acquire a credential file or token env.
      fs.writeFileSync(sourceAuthPath, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
        tokens: { id_token: syntheticToken, access_token: syntheticToken,
          refresh_token: "owned-synthetic-refresh-never-used", account_id: syntheticAccountId },
        last_refresh: new Date().toISOString() }), { mode: 0o600 });
      fs.writeFileSync(path.join(nativeSourceHome, "config.toml"), 'cli_auth_credentials_store="file"\nchatgpt_base_url="http://127.0.0.1:'
        + provider.address().port + '"\nmodel="gpt-6.1-sol"\ndeveloper_instructions=' + JSON.stringify(privateMarker) + "\n", { mode: 0o600 });
      const sourcePaths = [sourceAuthPath, path.join(nativeSourceHome, "config.toml"), ...(privateContextFixtures ? [path.join(nativeSourceHome, "AGENTS.md"), path.join(home, "AGENTS.md"), path.join(work, "AGENTS.md"), ...skillPaths,
        ...["memory_summary.md", "MEMORY.md"].map(name => path.join(memories, name))] : [])];
      nativeSourceBefore = Object.fromEntries(sourcePaths.map(file => [file, hash(file)]));
      nativeAuth = new NativeCodexAuth({ paths, repoRoot: MAIN, homedir: home, parentEnv,
        schemaContract: new CodexSchemaContract({ repoRoot: REPO }),
        prepareRuntime: async () => ({ spawnEnv: {}, registeredSecrets: [], configArgs: permissionConfigArgs(config) }),
        spawnProcess(command, args, options) {
          assert(freeSpace() >= 1024 ** 3, "minimum 1 GiB available at auth-only native launch");
          assert.equal(command, binary); assert.equal(options.env.HOME, home); assert.equal(options.env.CODEX_HOME, nativeSourceHome);
          assert(!Object.values(options.env).some(value => typeof value === "string" && value.includes(syntheticToken)));
          const authChild = spawn(command, args, options); authChildren.push(authChild);
          let authWire = "";
          authChild.stdout.on("data", bytes => { authWire += bytes.toString(); for (let end; (end = authWire.indexOf("\n")) >= 0;) {
            const line = authWire.slice(0, end); authWire = authWire.slice(end + 1); const frame = JSON.parse(line);
            if (frame.error || frame.method === "error") authSourceErrors.push(JSON.parse(JSON.stringify(frame)
              .replaceAll(syntheticToken, "[synthetic-token]").replaceAll(privateMarker, "[synthetic-context]")));
          } });
          const write = authChild.stdin.write.bind(authChild.stdin);
          authChild.stdin.write = (chunk, ...rest) => { const frame = JSON.parse(String(chunk));
            authRpcMethods.push({ method: frame.method ?? null, refreshToken: frame.params?.refreshToken ?? null }); return write(chunk, ...rest); };
          authChild.once("close", (code, signal) => authCloseReceipts.push({ pid: authChild.pid, code, signal })); return authChild;
        } });
      const sourceRead = nativeAuth.read.bind(nativeAuth);
      nativeAuth.read = async params => { try { return await sourceRead(params); } catch (error) {
        authReadFailures.push({ code: error.code ?? null, message: String(error.message).replaceAll(syntheticToken, "[synthetic-token]")
          .replaceAll(privateMarker, "[synthetic-context]") }); throw error;
      } };
    }
    fs.writeFileSync(path.join(environment.home, "config.toml"), 'model="gpt-6.1-sol"\nmodel_provider="owned_fixture"\nsandbox_mode="danger-full-access"\ndeveloper_instructions=' + JSON.stringify(privateMarker) +
      "\nmodel_instructions_file=" + JSON.stringify(privateInstructions) + '\nnotify=["/usr/bin/touch",' + JSON.stringify(notifyMarker)
      + (borrowedAuth ? ']\ncli_auth_credentials_store="file"\nchatgpt_base_url="http://127.0.0.1:' + provider.address().port + '"\n' : ']\n')
      + '[model_providers.owned_fixture]\nname="Owned local Responses only"\nbase_url="http://127.0.0.1:' + provider.address().port
      + '/v1"\nwire_api="responses"\nsupports_websockets=false\nrequires_openai_auth=' + (borrowedAuth ? "true" : "false") + "\n", { mode: 0o600 });
    host = new CodexRuntimeHost({ repoRoot: REPO, paths, runtimeBinding: binding, runtimeEnvironment: environment, cwd: work,
      parentEnv, homedir: home, nativeAuth, schemaContract: new CodexSchemaContract({ repoRoot: REPO }), requestTimeoutMs: 10000,
      prepareRuntime: async () => ({ spawnEnv: borrowedAuth ? {} : { SHOGGOTH_OWNED_FIXTURE_TOKEN: syntheticToken }, registeredSecrets: [],
        configArgs: permissionConfigArgs({ ...config, ...(borrowedAuth ? {} : { "model_providers.owned_fixture.env_key": "SHOGGOTH_OWNED_FIXTURE_TOKEN" }) }) }),
      spawnProcess(command, args, options) {
        assert(freeSpace() >= 1024 ** 3, "minimum 1 GiB available at native launch"); assert.equal(command, binary);
        assert.equal(options.env.HOME, home); assert.equal(options.env.CODEX_HOME, environment.home);
        nativeTokenObservedInSpawnEnv ||= borrowedAuth && Object.values(options.env).some(value => typeof value === "string" && value.includes(syntheticToken));
        child = useContextKernel ? spawn("/usr/bin/sandbox-exec", ["-f", kernelProfile, command, ...args], options) : spawn(command, args, options); const write = child.stdin.write.bind(child.stdin);
        let wire = ""; child.stdout.on("data", bytes => { wire += bytes.toString(); for (let end; (end = wire.indexOf("\n")) >= 0;) {
          const line = wire.slice(0, end); wire = wire.slice(end + 1); const frame = JSON.parse(line);
          nativeTokenObservedOutsideAccountRpc ||= borrowedAuth && line.includes(syntheticToken);
          if (frame.error || frame.method === "error") nativeWireErrors.push(frame);
        } });
        child.stdin.write = (chunk, ...rest) => { const frame = JSON.parse(String(chunk)); rpcMethods.push({ method: frame.method ?? null, id: frame.id ?? null });
          if (borrowedAuth && frame.method === "account/login/start") {
            borrowedAccountLoginIdentityMatched = frame.params?.type === "chatgptAuthTokens" && frame.params?.accessToken === syntheticToken
              && frame.params?.chatgptAccountId === syntheticAccountId;
          }
          return write(chunk, ...rest); };
        child.once("close", (code, signal) => { closeReceipt = { pid: child.pid, code, signal }; }); return child;
      } });
    wrapOwnedPermissionHost(host, config, wrapperEvidence);
    host.subscribe(event => { events.push({ type: event.type, threadId: event.threadId ?? null, turnId: event.turnId ?? null, status: event.status ?? null });
      if (event.type === "complete") completed.set(event.turnId, event.status);
      if (event.type === "error" && event.severity !== "warning" && !event.willRetry) errors.push({ code: event.code, turnId: event.turnId }); });
    const answered = new Set();
    host.registerServerRequestHandler("item/commandExecution/requestApproval", async (params, context) => {
      await waitFor(() => activeTurn !== null, 1000, "native approval must bind to acknowledged turn");
      const accepted = currentScenario === "approval" && params.kind === "command" && params.threadId === activeThread && params.turnId === activeTurn
        && params.cwd === work && !params.networkApprovalContext && commandMatches(params.command, exactCommand) && !answered.has(context.id);
      if (accepted) answered.add(context.id);
      const before = fs.existsSync(proof); await new Promise(resolve => setTimeout(resolve, 100));
      const row = { scenario: currentScenario, requestId: context.id, request: params, descriptorMatched: accepted,
        targetAbsentBeforeAnswer: !before && !fs.existsSync(proof), decision: accepted ? "accept" : "decline" };
      approvals.push(row); return { decision: row.decision };
    });
    host.registerServerRequestHandler("item/fileChange/requestApproval", async (params, context) => {
      approvals.push({ scenario: currentScenario, requestId: context.id, request: params, descriptorMatched: false, decision: "decline" });
      return { decision: "decline" };
    });
    await host.initialize(); check("exact pinned native Runtime", host.runtimeVersion === CODEX_VERSION);
    if (borrowedAuth) {
      const account = await host.accountRead({ refreshToken: false });
      check("formal adapter borrows the same synthetic native authority in memory", account.account?.type === "chatgpt"
        && account.authSource === "native-codex" && borrowedAccountLoginIdentityMatched);
      check("native auth-only source starts no thread, model or tool", authRpcMethods.length > 0
        && authRpcMethods.every(item => ["initialize", "initialized", "account/read", "getAuthStatus"].includes(item.method)));
      check("fresh source token requires no native auth refresh", authRpcMethods.every(item => item.refreshToken !== true));
    }
    const actualExecutable = execFileSync("/bin/ps", ["-p", String(child.pid), "-o", "comm="], { encoding: "utf8" }).trim();
    report.contextKernelPolicy = { path: kernelProfile, sha256: hash(kernelProfile), onlyContextReadDenied: useContextKernel,
      parentConfigAndAuthReadsDenied: false, childPid: child.pid, actualExecutable, binaryIdentityPreserved: actualExecutable === binary };
    check("context-only kernel wrapper preserves actual SDK executable", actualExecutable === binary);
    const allFeatures = await featureInventory(); report.featureCount = allFeatures.length;
    const readOnly = await host.rpc.request("command/exec", { command: ["/bin/sh", "-c", exactCommand], cwd: work, timeoutMs: 5000 }, { timeoutMs: 10000 });
    report.readOnlyCommand = readOnly; check("named read-only policy rejects exact write before approval", readOnly.exitCode !== 0 && !fs.existsSync(proof));
    await controlledTurn("context", allFeatures, false);
    await controlledTurn("code", allFeatures, false);
    const codeOutputs = requests.filter(item => item.scenario === "code").flatMap(item => item.payload.input ?? []).filter(item => item.type === "custom_tool_call_output");
    report.codeGuestOutputs = codeOutputs;
    check("code guest actually executes before ambient negative proof", codeOutputs.some(item => JSON.stringify(item).includes("OWNED_CODE_GUEST_RAN")));
    check("code guest cannot read parent-allowed config or inherited synthetic token", codeOutputs.length > 0 && codeOutputs.every(item => !JSON.stringify(item).includes(privateMarker) && !JSON.stringify(item).includes(syntheticToken)));
    await controlledTurn("approval", allFeatures, true);
    check("native exact descriptor requires and receives one allow_once answer", approvals.filter(row => row.scenario === "approval").length === 1 && approvals.some(row => row.scenario === "approval" && row.descriptorMatched && row.targetAbsentBeforeAnswer && row.decision === "accept"));
    check("approved exact descriptor writes only intended proof", fs.readFileSync(proof, "utf8") === "approval-evidence-v1");
    await controlledTurn("denied", allFeatures, true);
    check("every other native approval is declined", approvals.filter(row => row.scenario === "denied").length === 1 && approvals.some(row => row.scenario === "denied" && !row.descriptorMatched && row.decision === "decline"));
    check("declined command and disabled notify never execute", !fs.existsSync(denied) && !fs.existsSync(notifyMarker) && hash(outside) === outsideBefore);
    if (capabilityCanaries) {
      const toolOutputs = scenario => requests.filter(item => item.scenario === scenario).flatMap(item => item.payload.input ?? [])
        .filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
      await controlledTurn("patch-ro", allFeatures, false);
      check("actual read-only patch Guest executes", toolOutputs("patch-ro").some(item => JSON.stringify(item).includes("OWNED_APPLY_PATCH_GUEST_RAN")));
      check("read-only SDK apply_patch cannot write owned or private file", !fs.existsSync(readonlyPatch) && !fs.existsSync(outsidePatch));
      await controlledTurn("patch-rw", allFeatures, false);
      check("actual writable patch Guest executes", toolOutputs("patch-rw").some(item => JSON.stringify(item).includes("OWNED_APPLY_PATCH_GUEST_RAN")));
      check("implementation SDK apply_patch writes only owned workspace", fs.existsSync(writablePatch)
        && fs.readFileSync(writablePatch, "utf8") === "owned-patch-evidence-v1\n" && !fs.existsSync(outsidePatch));
      await controlledTurn("agent-list", allFeatures, false);
      report.nativeAgentOutputs = { list: toolOutputs("agent-list") };
      // Establish a real registry target before cross-agent canaries. Reject a
      // synthetic malformed UUID as insufficient evidence.
      const listed = report.nativeAgentOutputs.list.flatMap(item => typeof item.output === "string" ? [JSON.parse(item.output)] : []);
      const names = listed.flatMap(item => item.agents ?? []).map(item => item.agent_name).filter(name => typeof name === "string");
      check("native agent registry yields a real root target", names.includes("/root"));
      // The context thread is a real, loaded sibling root, rather than an
      // invented invalid identifier. It must not receive a message or turn.
      listedAgentTarget = report.threads.find(item => item.scenario === "context")?.id;
      const target = await host.threadRead({ threadId: listedAgentTarget, includeTurns: false });
      check("cross-agent target is an actual loaded owned sibling thread", target.thread.id === listedAgentTarget && listedAgentTarget !== activeThread);
      const completedTarget = await host.threadRead({ threadId: listedAgentTarget, includeTurns: true });
      check("owned sibling was created and completed inside this fixture", completedTarget.thread.turns.length === 1
        && completedTarget.thread.turns[0].status === "completed" && report.threads.some(item => item.id === listedAgentTarget && item.scenario === "context"));
      report.nativeAgentTarget = { listedRoots: names, siblingThreadId: listedAgentTarget, nativeThreadReadConfirmed: true,
        nativeCompletedTurnsBeforeCanaries: completedTarget.thread.turns.length, createdByThisFixture: true,
        syntheticNativeHome: environment.home, originalNativeHomeUsed: false };
      await controlledTurn("agent-spawn", allFeatures, false);
      report.nativeAgentOutputs.spawn = toolOutputs("agent-spawn");
      check("native delegation refuses an actual spawn attempt", report.nativeAgentOutputs.spawn.length > 0
        && report.nativeAgentOutputs.spawn.every(item => /(?:disabled|not enabled|not allowed|unavailable|limit|maximum)/i.test(JSON.stringify(item)))
        && report.nativeAgentOutputs.spawn.every(item => !/"agent_id"|"agent_name"/.test(JSON.stringify(item))));
      await controlledTurn("agent-message", allFeatures, false);
      report.nativeAgentOutputs.message = toolOutputs("agent-message");
      await controlledTurn("agent-followup", allFeatures, false);
      report.nativeAgentOutputs.followup = toolOutputs("agent-followup");
      if (interruptCanary) {
        await controlledTurn("agent-interrupt", allFeatures, false);
        report.nativeAgentOutputs.interrupt = toolOutputs("agent-interrupt");
      } else report.interruptAgentCanary = { executed: false, reason: "automatic approval review rejected the optional interrupt canary; no workaround execution" };
      check("native messages and followups cannot cross owned thread scope", ["message", "followup", ...(interruptCanary ? ["interrupt"] : [])].every(name => report.nativeAgentOutputs[name].length > 0
        && report.nativeAgentOutputs[name].every(item => /(?:disabled|not allowed|not found|unknown|unavailable|invalid|cannot|not.*sub.?agent)/i.test(JSON.stringify(item)))));
      await controlledTurn("agent-wait", allFeatures, false);
      report.nativeAgentOutputs.wait = toolOutputs("agent-wait");
      check("native wait has no foreign agent update", report.nativeAgentOutputs.wait.length > 0
        && report.nativeAgentOutputs.wait.every(item => !JSON.stringify(item).includes("OWNED_FORBIDDEN_CROSS_AGENT_MESSAGE")));
      const unchangedTarget = await host.threadRead({ threadId: listedAgentTarget, includeTurns: true });
      check("sibling target remains one completed controlled turn", unchangedTarget.thread.turns.length === 1
        && unchangedTarget.thread.turns[0].status === "completed");
      report.nativeAgentTarget.nativeCompletedTurnsAfterCanaries = unchangedTarget.thread.turns.length;
    }
    if (borrowedAuth) {
      const nativeSourceAfter = Object.fromEntries(Object.keys(nativeSourceBefore).map(file => [file, hash(file)]));
      const secretFiles = tokenFiles(root), expectedSource = path.join(nativeSourceHome, "auth.json");
      report.nativeAuthBridge = { sourceHome: nativeSourceHome, executionHome: environment.home,
        authorityKind: "existing-synthetic-native-chatgpt-borrowed-through-production-adapter", sourceBindingKind: "native-user",
        executionBindingAccount: binding.runtimeAccountId, syntheticAccountIdentityMatched: borrowedAccountLoginIdentityMatched,
        sourceBefore: nativeSourceBefore, sourceAfter: nativeSourceAfter,
        sourceUnchanged: JSON.stringify(nativeSourceBefore) === JSON.stringify(nativeSourceAfter),
        originalSyntheticAgentInstructionsRetained: !privateContextFixtures || hash(path.join(nativeSourceHome, "AGENTS.md")) === nativeSourceBefore[path.join(nativeSourceHome, "AGENTS.md")],
        authOnlyRpcMethods: authRpcMethods, authOnlyCloseReceipts: authCloseReceipts, routingRequests, metadataRequests,
        tokenInExecutionSpawnEnv: nativeTokenObservedInSpawnEnv, tokenInRawExecutionStdout: nativeTokenObservedOutsideAccountRpc,
        intentionallySeededSyntheticSourceCredentialFile: expectedSource,
        unexpectedTokenFiles: secretFiles.filter(file => file !== expectedSource), executionCredentialFileCreated: fs.existsSync(path.join(environment.home, "auth.json")),
        rawSecretValuesRecorded: false, refreshedOriginalSyntheticAuth: authRpcMethods.some(item => item.refreshToken === true) };
      check("source synthetic AGENTS, credentials and config remain byte-identical", report.nativeAuthBridge.sourceUnchanged);
      check("borrowed token is never written to execution files, env or tool output", !nativeTokenObservedInSpawnEnv && !nativeTokenObservedOutsideAccountRpc
        && report.nativeAuthBridge.unexpectedTokenFiles.length === 0 && !report.nativeAuthBridge.executionCredentialFileCreated);
      check("every final model request and tool body excludes the borrowed token", requests.every(item => item.tokenPresentInBody === false));
      check("formal borrowed authority never opens interactive login or chooses another account", borrowedAccountLoginIdentityMatched
        && rpcMethods.every(row => !row.method?.startsWith("account/") || ["account/read", "account/login/start"].includes(row.method)));
    } else check("original credentials and login never enter owned transport", !rpcMethods.some(row => /^(?:account\/|models\/)/.test(row.method ?? "")));
    check("local controlled endpoint receives exact bounded requests", requests.length === (capabilityCanaries ? (interruptCanary ? 23 : 21) : 7));
    report.modelDirectoryHasNativeCodeAndAgentNamespaces = report.actualToolClosure !== true;
    report.codeGuestCapabilityProofOnly = true;
    report.status = "passed";
  } catch (error) { report.error = { code: error.code ?? null, rpcCode: error.rpcCode ?? null, message: error.message }; report.status = "failed"; process.exitCode = 1; }
  finally {
    try {
      report.ownedProcessesBeforeStop = ownedProcesses();
      await host?.stop();
      await nativeAuth?.close();
      report.ownedProcessesAfterStop = ownedProcesses();
      report.ownedHandlePidsAfterStop = ownedHandlePids();
      report.freshOwnedStopVerified = report.ownedProcessesAfterStop.length === 0 && report.ownedHandlePidsAfterStop.length === 0;
      if (!report.freshOwnedStopVerified) throw new Error("owned process or handle remains after stop");
    } catch (error) { report.cleanupError = error.code ?? error.message; report.status = "failed"; process.exitCode = 1; }
    if (provider) await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    if (tlsProvider) await new Promise(resolve => { tlsProvider.close(resolve); tlsProvider.closeAllConnections(); });
    report.events = events; report.rpcMethods = rpcMethods; report.wrapperEvidence = wrapperEvidence; report.runtimeErrors = errors;
    report.nativeWireErrors = nativeWireErrors;
    report.nativeSdkSymlinks = nativeSdkSymlinks;
    if (borrowedAuth) report.nativeAuthDiagnostics = { rpcMethods: authRpcMethods, closeReceipts: authCloseReceipts,
      errors: authSourceErrors, readFailures: authReadFailures, routingRequests, metadataRequests };
    report.closeReceipt = closeReceipt ?? null; report.ownedRuntimeClosed = Boolean(closeReceipt);
    report.sourceAfter = Object.fromEntries(sourceFiles.map(relative => [relative, hash(path.join(REPO, relative))]));
    report.sourceUnchanged = JSON.stringify(beforeSource) === JSON.stringify(report.sourceAfter);
    if (!report.sourceUnchanged || !report.ownedRuntimeClosed || errors.length) { report.status = "failed"; process.exitCode = 1; }
    const output = path.join(root, "result.json"); fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: report.status, root, output, error: report.error ?? null,
      passedChecks: checks.filter(row => row.passed).length, controlledLocalTurns: report.controlledLocalTurns,
      localRequests: requests.length, remoteModelCalls: 0, sourceUnchanged: report.sourceUnchanged, ownedRuntimeClosed: report.ownedRuntimeClosed }) + "\n");
  }
})().catch(error => { process.stderr.write(String(error.stack) + "\n"); process.exitCode = 1; });
