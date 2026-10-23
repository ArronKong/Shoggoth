"use strict";

// Opt-in source-mode proof that one App-entered GitHub credential and one
// global Connection serve native, OpenClaw and Hermes production adapters.
// External adapters are invoked through their trusted fixture host callbacks;
// this is not a real OpenClaw Gateway or Hermes model-run acceptance.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");
const { REPOSITORY, SEED, REQUIRED, launch, waitForConnection, withRun,
  grantTools, requireOperatorGate, resultContains, assertMcpSuccess,
} = require("./plugin-github-real-acceptance.cjs");

const SEARCH = "shoggoth_capability_search";
const CALL = "shoggoth_plugin_call";
const READ = Object.freeze(["get_file_contents", "issue_read"]);
const WRITE = Object.freeze(["create_or_update_file", "add_issue_comment"]);
const OPENCLAW = Object.freeze({ backendId: "openclaw",
  instanceId: "openclaw-github-three-adapter-acceptance",
  agentId: "openclaw-github-three-adapter-agent",
  sessionId: "openclaw-github-three-adapter-session",
  runId: "openclaw-github-three-adapter-run" });
const HERMES = Object.freeze({ backendId: "hermes",
  instanceId: "hermes-three-host-fixture", agentId: "hermes-default",
  sessionId: "hermes-three-host-session", taskId: "hermes-three-host-task" });
const safeCodes = new Set(["CAPABILITY_FORBIDDEN", "CONNECT_WAIT_TIMEOUT",
  "LIVE_TOOL_CONTRACT_MISMATCH", "MCP_AUTH_FAILED", "MCP_AUTH_REQUIRED",
  "MCP_SERVER_EXITED", "MCP_SERVER_RESPONSE_INVALID", "MCP_SERVER_RESPONSE_TOO_LARGE",
  "MCP_RESULT_UNVERIFIED", "OPERATOR_GATE_CLOSED", "OPERATOR_GATE_DENIED",
  "OPERATOR_STOPPED", "SERVICE_UNAVAILABLE", "TOOL_CONTRACT_CHANGED"]);
const repo = Object.freeze({ owner: REPOSITORY.owner, repo: REPOSITORY.repo });

function verifyFixtureAgent(identity) {
  const openclaw = identity && Object.keys(identity).length === Object.keys(OPENCLAW).length + 1
    && Object.entries(OPENCLAW).every(([key, value]) => identity[key] === value)
    && /^openclaw-github-three-adapter-call-[1-3]$/u.test(identity.toolCallId);
  const hermes = identity && Object.keys(identity).length === Object.keys(HERMES).length + 2
    && Object.entries(HERMES).every(([key, value]) => identity[key] === value)
    && /^hermes-three-host-turn-[0-1]$/u.test(identity.turnId)
    && identity.toolCallId === identity.turnId.replace("turn", "call");
  return openclaw || hermes ? { id: identity.agentId,
    backendId: identity.backendId } : null;
}

function fixedReadArguments(name) {
  if (name === "get_file_contents") return { ...repo,
    path: "fixtures/input.txt", ref: REPOSITORY.branch };
  if (name === "issue_read") return { ...repo,
    method: "get", issue_number: REPOSITORY.issue };
  throw Object.assign(new Error(), { code: "READ_ONLY_TOOL_REQUIRED" });
}

function assertFixedRead(name, result) {
  const checked = assertMcpSuccess({ result });
  if (name === "get_file_contents") {
    assert(resultContains(checked, SEED.fileLine)
      && resultContains(checked, SEED.initialValue));
  } else if (name === "issue_read") {
    assert(resultContains(checked, SEED.issueTitle)
      && resultContains(checked, SEED.issueBody));
  } else throw Object.assign(new Error(), { code: "READ_ONLY_TOOL_REQUIRED" });
}

const liveReadPlan = Object.freeze({ searchQuery: "github",
  tools: READ.map(name => ({ name, arguments: fixedReadArguments(name) })),
  verify: assertFixedRead });

function rpc(paths, method, params, options = {}) {
  return requestService(paths, { version: SERVICE_PROTOCOL_VERSION, method, params },
    { timeoutMs: options.timeoutMs || 120_000, signal: options.signal });
}

async function openclawReads(context, serverId, plan = liveReadPlan) {
  const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
    "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
  const credential = ensureCredential(context.paths, "openclaw");
  const adapter = createAdapter({ instanceId: OPENCLAW.instanceId,
    credential: () => credential,
    requestService: (method, params, options) => rpc(context.paths, method, params, options) });
  let callNumber = 0;
  const invoke = async (name, args) => {
    const toolCallId = `openclaw-github-three-adapter-call-${++callNumber}`;
    const host = { agentId: OPENCLAW.agentId, sessionId: OPENCLAW.sessionId,
      runId: OPENCLAW.runId };
    assert.equal(adapter.beforeToolCall({ toolName: name, toolCallId,
      runId: host.runId }, host), undefined);
    return (await adapter.tool(name, host).execute(toolCallId, args)).details;
  };
  const catalog = await invoke(SEARCH, { query: plan.searchQuery });
  assert(plan.tools.every(tool => catalog.items.some(item => item.serverId === serverId
    && item.name === tool.name)), "OpenClaw adapter did not see expected Grants");
  for (const tool of plan.tools) {
    const name = tool.name;
    const result = await invoke(CALL, { serverId, toolName: name,
      arguments: tool.arguments });
    plan.verify(name, result.result);
  }
}

function hermesProbe(serviceRoot, sandboxRoot, serverId, plan) {
  return new Promise((resolve, reject) => {
    const commands = plan.tools.map(tool => ({ name: CALL, args: { serverId,
      toolName: tool.name, arguments: tool.arguments } }));
    const child = spawn(process.env.SHOGGOTH_TEST_PYTHON_BIN || "python3",
      [path.join(__dirname, "plugin-three-host-hermes-probe.py")], {
        env: { HOME: sandboxRoot, CODEX_HOME: path.join(sandboxRoot, "codex-home"),
          PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: sandboxRoot,
          LANG: "en_US.UTF-8", PYTHONDONTWRITEBYTECODE: "1",
          SHOGGOTH_THREE_HOST_SERVICE_ROOT: serviceRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
    let stdout = "";
    let failureCode = null;
    let killTimer;
    const stop = code => {
      failureCode ||= code;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timer = setTimeout(() => stop("HERMES_PROBE_TIMEOUT"), 180_000);
    child.stdout.on("data", bytes => {
      if (failureCode) return;
      stdout += bytes;
      if (stdout.length > 256 * 1024) stop("HERMES_PROBE_TOO_LARGE");
    });
    // Never print child stderr or response body: a provider can return data.
    child.stderr.resume();
    child.stdin.on("error", () => stop("HERMES_PROBE_FAILED"));
    child.on("error", () => { failureCode ||= "HERMES_PROBE_FAILED"; });
    child.on("close", code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failureCode || code !== 0) {
        reject(Object.assign(new Error(), { code: failureCode || "HERMES_PROBE_FAILED" }));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(Object.assign(new Error(), { code: "HERMES_PROBE_INVALID" })); }
    });
    child.stdin.end(JSON.stringify({ commands }));
  });
}

async function hermesReads(context, serverId, plan = liveReadPlan) {
  ensureCredential(context.paths, "hermes");
  const results = await hermesProbe(context.paths.userDataRoot, context.root,
    serverId, plan);
  assert(Array.isArray(results) && results.length === plan.tools.length);
  plan.tools.forEach((tool, index) => plan.verify(tool.name, results[index]?.result));
}

async function assertSharedAuthority(context, binding, report) {
  const connection = context.service.pluginStore.getConnection(binding.connectionId);
  const bindings = context.service.pluginStore.listGlobalBindings();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].bindingId, binding.bindingId);
  assert.equal(connection?.state, "ready");
  assert.match(connection.principalIdentity, /^github:[1-9][0-9]{0,19}$/u);
  const catalog = await context.backend.getPluginMcpTools(context.profile.agentId,
    binding.bindingId);
  assert(READ.every(name => catalog.items.some(item => item.name === name
    && item.savedGrant?.effect === "allow")));
  assert(WRITE.every(name => catalog.items.some(item => item.name === name
    && !item.savedGrant)), "write tools must remain ungranted");
  const audited = (await context.backend.getPluginExternalCalls({ limit: 20 })).items
    .filter(item => item.bindingId === binding.bindingId);
  assert.equal(audited.length, 4);
  assert.deepEqual(new Set(audited.map(item => item.backendId)),
    new Set(["openclaw", "hermes"]));
  assert(audited.every(item => item.connectionId === connection.connectionId
    && item.status === "confirmed" && READ.includes(item.toolName)));
  report.oneGlobalBinding = true;
  report.oneVerifiedConnection = true;
  report.externalReadCallsAudited = audited.length;
  report.writeGrants = 0;
}

async function revokeReads(context, binding) {
  for (const name of READ) {
    const catalog = await context.backend.getPluginMcpTools(context.profile.agentId,
      binding.bindingId);
    const tool = catalog.items.find(item => item.name === name);
    assert(tool?.savedGrant?.effect === "allow");
    await context.backend.revokePluginMcpGrant({ agentId: context.profile.agentId,
      bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
      expectedRevision: tool.savedGrant.revision,
      operationId: `three-adapter-github-revoke-${name}-${crypto.randomUUID()}` });
  }
  const catalog = await context.backend.getPluginMcpTools(context.profile.agentId,
    binding.bindingId);
  assert(READ.every(name => catalog.items.find(item => item.name === name)
    ?.savedGrant?.effect === "deny"));
}

async function runLive() {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let context;
  const report = { kind: "real-github-three-adapter-source-mode",
    repository: `${REPOSITORY.owner}/${REPOSITORY.repo}`, stage: "startup",
    actualExternalCliModelRuns: false };
  try {
    context = await launch({ live: true,
      // This acceptance fixture has no external host registry. It permits only
      // the exact synthetic host identities exercised below, and cannot prove
      // production agent.get verification or real host-to-turn binding.
      externalPluginAgentVerifier: verifyFixtureAgent });
    console.log(`GITHUB_THREE_ADAPTER_READY ${context.web.url}/#/plugins`);
    console.log("Connect the installed GitHub card once in this temporary UI with the repository-scoped PAT. Do not enter it in chat or terminal.");
    report.stage = "waiting-for-app-connection";
    const binding = await waitForConnection(context, abort.signal);
    report.verifiedGitHubPrincipal = true;
    report.stage = "read-only-discovery";
    await context.backend.discoverPluginMcpTools(context.profile.agentId, binding.bindingId);
    const catalog = await context.backend.getPluginMcpTools(context.profile.agentId,
      binding.bindingId);
    const operations = new Set((catalog.portableCapabilities || []).map(item => item.toolName));
    assert(REQUIRED.every(name => operations.has(name)));
    assert(WRITE.every(name => catalog.items.some(item => item.name === name
      && !item.savedGrant)));
    await requireOperatorGate(`GRANT_READ_THREE_ADAPTER ${REPOSITORY.owner}/${REPOSITORY.repo}`,
      abort.signal);
    await grantTools(context, binding, catalog, READ);
    report.readGrants = READ.length;
    const serverId = pluginServerId(binding.bindingId);
    report.stage = "native-read";
    await withRun(context, binding.bindingId, async call => {
      for (const name of READ) assertFixedRead(name,
        await call(name, fixedReadArguments(name)));
    });
    report.nativeReadVerified = true;
    report.stage = "openclaw-adapter-read";
    await openclawReads(context, serverId);
    report.openclawAdapterReadVerified = true;
    report.stage = "hermes-adapter-read";
    await hermesReads(context, serverId);
    report.hermesAdapterReadVerified = true;
    await assertSharedAuthority(context, binding, report);
    report.stage = "revoke-read-grants";
    await revokeReads(context, binding);
    report.readGrantsRevoked = true;
    report.stage = "complete";
  } catch (error) {
    report.errorCode = safeCodes.has(error?.code) ? error.code : "ACCEPTANCE_ASSERTION_FAILED";
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (context) {
      try { await context.close(); }
      catch { report.cleanup = "failed"; process.exitCode = 1; }
    }
    console.log(`GITHUB_THREE_ADAPTER_RESULT ${JSON.stringify(report)}`);
  }
}

async function selfTest() {
  assert.equal(READ.length, 2);
  assert.equal(WRITE.length, 2);
  assert.deepEqual(new Set([...READ, ...WRITE]), new Set(REQUIRED));
  assert.equal(verifyFixtureAgent({ ...OPENCLAW,
    toolCallId: "openclaw-github-three-adapter-call-1" })?.backendId, "openclaw");
  assert.equal(verifyFixtureAgent({ ...HERMES,
    turnId: "hermes-three-host-turn-0",
    toolCallId: "hermes-three-host-call-0" })?.backendId, "hermes");
  assert.equal(verifyFixtureAgent({ ...OPENCLAW, backendId: "hermes",
    toolCallId: "openclaw-github-three-adapter-call-1" }), null);
  assert.throws(() => fixedReadArguments("create_or_update_file"),
    error => error.code === "READ_ONLY_TOOL_REQUIRED");
  const file = { content: [{ type: "text",
    text: `${SEED.fileLine}\n${SEED.initialValue}` }] };
  assertFixedRead("get_file_contents", file);
  assert.throws(() => assertFixedRead("issue_read", file));
  const oldUmask = process.umask(0o077);
  let root;
  try { root = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "sg-g3a-"))); }
  finally { process.umask(oldUmask); }
  const fixture = createFixture(root, "openclaw", {
    externalPluginAgentVerifier: verifyFixtureAgent });
  try {
    const service = await fixture.start();
    const business = await fixture.installMcpTool();
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    const binding = service.pluginStore.getBinding(business.bindingId);
    assert.equal(binding.subjectKind, "global");
    const connection = service.pluginStore.getConnection(binding.connectionId);
    assert.equal(connection.state, "ready");
    const context = { root, paths: fixture.paths, service,
      backend: new ShoggothBackend({ paths: fixture.paths }), profile };
    const plan = { searchQuery: "echo", tools: [{ name: "echo",
      arguments: { value: "three-adapter-local-read" } }],
    verify(name, result) {
      assert.equal(name, "echo");
      assert.equal(assertMcpSuccess({ result }).structuredContent?.echoed,
        "three-adapter-local-read");
    } };
    await withRun(context, business.bindingId, async call => {
      plan.verify("echo", await call("echo", plan.tools[0].arguments));
    });
    await openclawReads(context, business.serverId, plan);
    await hermesReads(context, business.serverId, plan);
    const audited = (await fixture.listAuditedCalls(null)).items;
    assert.equal(audited.length, 2);
    assert.deepEqual(new Set(audited.map(item => item.backendId)),
      new Set(["openclaw", "hermes"]));
    assert(audited.every(item => item.bindingId === business.bindingId
      && item.connectionId === connection.connectionId && item.status === "confirmed"));
    console.log("plugin-github-three-adapter-real-acceptance: SELF_TEST_PASS");
  } finally {
    await fixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--self-test", "--live"].includes(args[0])) {
    console.error("Usage: node scripts/plugin-github-three-adapter-real-acceptance.cjs --self-test|--live");
    process.exitCode = 2;
  } else void (args[0] === "--live" ? runLive() : selfTest()).catch(error => {
    console.error(args[0] === "--self-test" ? error?.stack
      : "GITHUB_THREE_ADAPTER_UNAVAILABLE");
    process.exitCode = 1;
  });
}

module.exports = { verifyFixtureAgent, fixedReadArguments, assertFixedRead };
