"use strict";

// One isolated Service owns one installation, global binding, connection and
// Grant. Native Runtime and both production external adapters use that same
// authority and a real local stdio MCP child. The external host CLI/model is
// not started here; their separate real-host fixtures cover host integration.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { createFixture, SKILL_ID } = require("./plugin-real-host-service-fixture.cjs");

const SEARCH = "shoggoth_capability_search";
const READ = "shoggoth_skill_read";
const CALL = "shoggoth_plugin_call";

function runHermesProbe(serviceRoot, commands) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHOGGOTH_TEST_PYTHON_BIN || "python3",
      [path.join(__dirname, "plugin-three-host-hermes-probe.py")], {
        env: { ...process.env, SHOGGOTH_THREE_HOST_SERVICE_ROOT: serviceRoot,
          PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"],
      });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Hermes adapter probe exited ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(
        `Hermes adapter probe response invalid: ${error.message}; ${stdout}; ${stderr}`)); }
    });
    child.stdin.end(JSON.stringify({ commands }));
  });
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-three-host-")));
  const fixture = createFixture(root, "openclaw");
  let service = null;
  let runId = null;
  try {
    service = await fixture.start();
    const installedSkill = fixture.install();
    const business = await fixture.installMcpTool();
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile, "isolated Service must have a native Profile");

    const binding = service.pluginStore.getBinding(business.bindingId);
    assert.equal(binding.subjectKind, "global");
    assert.equal(binding.installationId, business.installationId);
    assert.equal(binding.enabled, true);
    assert.equal(service.pluginStore.listGlobalBindings().length, 1);
    assert.equal(service.pluginStore.getConnection(binding.connectionId).state, "ready");
    assert.equal(service.pluginStore.getConnectionCountsForComponent(
      binding.installationId, binding.componentId).verified, 1);
    assert.equal(service.pluginStore.getGrantCountsForBinding(binding.bindingId).allow, 1);
    assert.equal(service.pluginStore.getGrant(binding.bindingId, business.toolIdentity).effect, "allow");

    // The native Run freezes the same Service-owned global binding and calls
    // the actual local MCP child through the production dispatcher.
    const nativeSkill = service.runtimeSkillStore.catalog(profile.id).items.find(item =>
      item.name === SKILL_ID);
    assert(nativeSkill);
    assert.match(service.runtimeSkillStore.read({ profileId: profile.id,
      name: nativeSkill.name, contentHash: nativeSkill.contentHash }).content, /Host probe/u);
    const nativePluginSkill = service.runtimeSkillStore.catalog(profile.id).items.find(item =>
      item.source === "plugin");
    assert(nativePluginSkill, "plugin Skill must be visible to native Profile");
    assert.match(service.runtimeSkillStore.read({ profileId: profile.id,
      name: nativePluginSkill.name, contentHash: nativePluginSkill.contentHash }).content,
    /issue-summary/u);
    runId = crypto.randomUUID();
    service.workDispatcher.enqueue({ id: runId, source: "chat", sourceId: "three-host-chat",
      idempotencyKey: "three-host-native-run", profileId: profile.id, workspace: root });
    const admitted = service.workDispatcher.admit(runId, { writable: false });
    assert.equal(admitted.disposition, "started");
    assert.equal(service.pluginRuntimeToolService.captureRun(admitted.run).serverCount, 1);
    service.workDispatcher.transition(runId, "running");
    const nativeScope = { runId, assertCurrent() {
      assert.equal(service.workDispatcher.getRun(runId).status, "running");
    } };
    const nativeAuthority = () => ({ profileId: profile.id, callId: crypto.randomUUID() });
    assert.equal(service.pluginRuntimeToolService.listServers(nativeAuthority(), nativeScope)[0].id,
      business.serverId);
    const nativeResult = await service.pluginRuntimeToolService.callTool({
      serverId: business.serverId, toolName: business.toolName,
      arguments: { value: "native-shared" },
    }, nativeAuthority(), nativeScope);
    assert.equal(nativeResult.result.structuredContent.echoed, "native-shared");

    const rpc = (method, params, options = {}) => requestService(fixture.paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000 });
    const openclawToken = fixture.credential;
    const hermesToken = ensureCredential(fixture.paths, "hermes");
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const openclaw = createAdapter({ instanceId: "openclaw-three-host-fixture",
      credential: () => openclawToken,
      requestService: (method, params, options) => rpc(method, params, options),
    });
    let openclawCall = 0;
    const openclawInvoke = async (name, args) => {
      const toolCallId = `openclaw-three-host-call-${++openclawCall}`;
      const context = { agentId: "openclaw-three-host-agent",
        sessionId: "openclaw-three-host-session", runId: "openclaw-three-host-run" };
      assert.equal(openclaw.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      return (await openclaw.tool(name, context).execute(toolCallId, args)).details;
    };
    const openclawSearch = await openclawInvoke(SEARCH, { query: "" });
    const sharedSkill = openclawSearch.items.find(item => item.name === SKILL_ID);
    const pluginSkill = openclawSearch.items.find(item => item.kind === "skill"
      && item.source !== "native-skill");
    const sharedTool = openclawSearch.items.find(item => item.kind === "tool"
      && item.serverId === business.serverId && item.name === business.toolName);
    assert.equal(sharedSkill.id, installedSkill.componentId);
    assert(pluginSkill, "OpenClaw adapter must see installed plugin Skill");
    assert(sharedTool, "OpenClaw adapter must see the shared MCP Grant");
    assert.match((await openclawInvoke(READ, { skillId: sharedSkill.id })).content, /Host probe/u);
    assert.match((await openclawInvoke(READ, { skillId: pluginSkill.id })).content, /issue-summary/u);
    assert.equal((await openclawInvoke(CALL, { serverId: business.serverId,
      toolName: business.toolName, arguments: { value: "openclaw-shared" } }))
      .result.structuredContent.echoed, "openclaw-shared");

    const hermesResults = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: "" } },
      { name: READ, args: { skillId: sharedSkill.id } },
      { name: READ, args: { skillId: pluginSkill.id } },
      { name: CALL, args: { serverId: business.serverId,
        toolName: business.toolName, arguments: { value: "hermes-shared" } } },
    ]);
    assert(hermesResults[0].items.some(item => item.id === sharedSkill.id));
    assert(hermesResults[0].items.some(item => item.id === pluginSkill.id));
    assert(hermesResults[0].items.some(item => item.serverId === business.serverId
      && item.name === business.toolName));
    assert.match(hermesResults[1].content, /Host probe/u);
    assert.match(hermesResults[2].content, /issue-summary/u);
    assert.equal(hermesResults[3].result.structuredContent.echoed, "hermes-shared");

    const calls = (await fixture.listAuditedCalls(null)).items.filter(item =>
      item.bindingId === binding.bindingId);
    assert.equal(calls.length, 2);
    assert.deepEqual(new Set(calls.map(item => item.backendId)), new Set(["openclaw", "hermes"]));
    assert(calls.every(item => item.installationId === business.installationId
      && item.connectionId === binding.connectionId && item.status === "confirmed"));
    assert.equal(service.pluginStore.listGlobalBindings().length, 1,
      "three adapters must not create backend-specific bindings");

    // Freeze external leases while the Grant is live. A later revocation must
    // reject these old snapshots as well as the already-admitted native Run.
    const oldOpenclawIdentity = { backendId: "openclaw", instanceId: "openclaw-three-host-fixture",
      agentId: "openclaw-three-host-agent", sessionId: "openclaw-stale-session",
      runId: "openclaw-stale-run", toolCallId: "openclaw-stale-call" };
    const oldHermesIdentity = { backendId: "hermes", instanceId: "hermes-three-host-fixture",
      agentId: "hermes-default", sessionId: "hermes-stale-session",
      taskId: "hermes-stale-task", turnId: "hermes-stale-turn",
      toolCallId: "hermes-stale-call" };
    const oldOpenclawLease = await rpc("plugin.external.open", {
      credentialToken: openclawToken, identity: oldOpenclawIdentity });
    const oldHermesLease = await rpc("plugin.external.open", {
      credentialToken: hermesToken, identity: oldHermesIdentity });
    await business.revoke();
    assert.equal(service.pluginStore.getGrant(binding.bindingId, business.toolIdentity).effect, "deny");
    await assert.rejects(service.pluginRuntimeToolService.callTool({
      serverId: business.serverId, toolName: business.toolName,
      arguments: { value: "native-revoked" },
    }, nativeAuthority(), nativeScope), error => error.code === "GRANT_REVOKED");
    for (const [lease, identity] of [[oldOpenclawLease, oldOpenclawIdentity],
      [oldHermesLease, oldHermesIdentity]]) {
      await assert.rejects(rpc("plugin.external.call", { token: lease.token, identity,
        serverId: business.serverId, toolName: business.toolName,
        arguments: { value: "stale-revoked" } }), error => error.code === "GRANT_REVOKED");
    }
    await assert.rejects(openclawInvoke(CALL, { serverId: business.serverId,
      toolName: business.toolName, arguments: { value: "openclaw-revoked" } }),
    error => error.code === "CAPABILITY_FORBIDDEN");
    const hermesRevoked = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: CALL, args: { serverId: business.serverId,
        toolName: business.toolName, arguments: { value: "hermes-revoked" } } },
    ]);
    assert.equal(hermesRevoked[0].code, "CAPABILITY_FORBIDDEN");
    assert.equal((await fixture.listAuditedCalls(null)).items.filter(item =>
      item.bindingId === binding.bindingId).length, 2,
    "revocation must reject all old and new calls before downstream send");
    const stillVisible = await openclawInvoke(SEARCH, { query: SKILL_ID });
    assert(stillVisible.items.some(item => item.id === sharedSkill.id));
    assert(!stillVisible.items.some(item => item.kind === "tool"),
      "revoked MCP Grant must leave unrelated Skill usable");

    fixture.disable();
    assert(!service.runtimeSkillStore.catalog(profile.id).items.some(item => item.name === SKILL_ID));
    assert.throws(() => service.runtimeSkillStore.read({ profileId: profile.id,
      name: SKILL_ID }), error => error.code === "SKILL_NOT_ENABLED");
    assert.equal((await openclawInvoke(SEARCH, { query: SKILL_ID })).items.length, 0);
    const hermesDisabled = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: SKILL_ID } },
    ]);
    assert.equal(hermesDisabled[0].items.length, 0);
    console.log("plugin-three-host-shared-service-fixture: ok", JSON.stringify({
      service: "one isolated Service", native: "Runtime Skill + stdio MCP",
      external: ["OpenClaw adapter", "Hermes adapter"],
      sharedAuthority: { installations: 1, bindings: 1, readyConnections: 1, grants: 1 },
      revokedOldCalls: 3, liveProviderAccount: false,
    }));
  } finally {
    if (service && runId && service.workDispatcher.getRun(runId)?.status === "running") {
      service.pluginRuntimeToolService.releaseRun(runId);
      service.workDispatcher.transition(runId, "completed");
    }
    await fixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
