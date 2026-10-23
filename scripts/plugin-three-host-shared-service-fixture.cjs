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
const FILE_READ = "shoggoth_skill_file_read";
const RESOURCE_READ = "shoggoth_plugin_resource_read";
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
    const issueDescriptor = service.pluginComponentResolver.listEnabledSkillDescriptors(profile.id)
      .find(item => item.name === "issue-summary");
    const echoDescriptor = service.pluginComponentResolver.listEnabledSkillDescriptors(profile.id)
      .find(item => item.name === "echo-workflow");
    assert(issueDescriptor && echoDescriptor);
    const nativePluginSkill = service.runtimeSkillStore.catalog(profile.id).items.find(item =>
      item.id === issueDescriptor.componentId);
    assert(nativePluginSkill, "plugin Skill must be visible to native Profile");
    assert.match(service.runtimeSkillStore.read({ profileId: profile.id,
      name: nativePluginSkill.name, contentHash: nativePluginSkill.contentHash }).content,
    /issue-summary/u);
    const fileInput = (skill, relativePath) => ({ name: skill.name,
      contentHash: skill.contentHash, relativePath, cursor: 0, maxBytes: 4_096 });
    const nativeAuthority = () => ({ profileId: profile.id, callId: crypto.randomUUID() });
    assert.equal(service.runtimeSkillStore.readFile({ profileId: profile.id,
      ...fileInput(nativeSkill, "references/host-guide.md") }).content,
    "Shared native host guide 😀\n");
    const productCatalog = await service.mcpProductToolController.handle("skill_catalog",
      { cursor: 0, limit: 10 }, nativeAuthority());
    assert(productCatalog.items.some(item => item.name === nativeSkill.name));
    const nativeFile = await service.mcpProductToolController.handle("skill_file_read",
      fileInput(nativeSkill, "references/host-guide.md"), nativeAuthority());
    const pluginFile = await service.mcpProductToolController.handle("skill_file_read",
      fileInput(nativePluginSkill, "references/guide.md"), nativeAuthority());
    assert.equal(nativeFile.content, "Shared native host guide 😀\n");
    assert.equal(pluginFile.content, "Shared plugin host guide 😀\n");
    assert.equal(nativeFile.relativePath, "references/host-guide.md");
    assert.equal(pluginFile.relativePath, "references/guide.md");
    assert.match(nativeFile.fileHash, /^[a-f0-9]{64}$/u);
    assert.match(pluginFile.fileHash, /^[a-f0-9]{64}$/u);
    await assert.rejects(service.mcpProductToolController.handle("skill_file_read",
      { ...fileInput(nativeSkill, "references/host-guide.md"), contentHash: "0".repeat(64) },
      nativeAuthority()), error => error.code === "MCP_TOOL_NOT_FOUND");
    await assert.rejects(service.mcpProductToolController.handle("skill_file_read",
      fileInput(nativeSkill, "../SKILL.md"), nativeAuthority()),
    error => error.code === "MCP_TOOL_INVALID_ARGUMENTS");
    await assert.rejects(service.mcpProductToolController.handle("skill_file_read",
      fileInput(nativeSkill, "references/missing.md"), nativeAuthority()),
    error => error.code === "MCP_TOOL_INVALID_ARGUMENTS");
    const installedNativeFile = path.join(fixture.paths.skillPackagesDir, SKILL_ID,
      installedSkill.package.version, "references", "host-guide.md");
    const originalNativeFile = fs.readFileSync(installedNativeFile);
    try {
      fs.writeFileSync(installedNativeFile, "Mutated after installation\n");
      await assert.rejects(service.mcpProductToolController.handle("skill_file_read",
        fileInput(nativeSkill, "references/host-guide.md"), nativeAuthority()),
      error => error.code === "MCP_TOOL_UNAVAILABLE");
    } finally {
      fs.writeFileSync(installedNativeFile, originalNativeFile);
    }
    assert.equal((await service.mcpProductToolController.handle("skill_file_read",
      fileInput(nativeSkill, "references/host-guide.md"), nativeAuthority())).content,
    nativeFile.content);
    runId = crypto.randomUUID();
    service.workDispatcher.enqueue({ id: runId, source: "chat", sourceId: "three-host-chat",
      idempotencyKey: "three-host-native-run", profileId: profile.id, workspace: root });
    const admitted = service.workDispatcher.admit(runId, { writable: false });
    assert.equal(admitted.disposition, "started");
    assert.equal(service.pluginRuntimeToolService.captureRun(admitted.run).serverCount, 1);
    service.hookService.freezeRun(admitted.run, profile);
    service.workDispatcher.transition(runId, "running");
    const nativeScope = { runId, assertCurrent() {
      assert.equal(service.workDispatcher.getRun(runId).status, "running");
    } };
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
    const pluginSkill = openclawSearch.items.find(item => item.id === issueDescriptor.componentId);
    const sharedTool = openclawSearch.items.find(item => item.kind === "tool"
      && item.serverId === business.serverId && item.name === business.toolName);
    assert.equal(sharedSkill.id, installedSkill.componentId);
    assert(pluginSkill, "OpenClaw adapter must see installed plugin Skill");
    assert(sharedTool, "OpenClaw adapter must see the shared MCP Grant");
    assert.match((await openclawInvoke(READ, { skillId: sharedSkill.id })).content, /Host probe/u);
    assert.match((await openclawInvoke(READ, { skillId: pluginSkill.id })).content, /issue-summary/u);
    assert.equal((await openclawInvoke(FILE_READ, { skillId: sharedSkill.id,
      relativePath: "references/host-guide.md" })).content, nativeFile.content);
    assert.equal((await openclawInvoke(FILE_READ, { skillId: pluginSkill.id,
      relativePath: "references/guide.md" })).content, pluginFile.content);
    assert.equal((await openclawInvoke(CALL, { serverId: business.serverId,
      toolName: business.toolName, arguments: { value: "openclaw-shared" } }))
      .result.structuredContent.echoed, "openclaw-shared");

    const hermesResults = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: "" } },
      { name: READ, args: { skillId: sharedSkill.id } },
      { name: READ, args: { skillId: pluginSkill.id } },
      { name: FILE_READ, args: { skillId: sharedSkill.id,
        relativePath: "references/host-guide.md" } },
      { name: FILE_READ, args: { skillId: pluginSkill.id,
        relativePath: "references/guide.md" } },
      { name: CALL, args: { serverId: business.serverId,
        toolName: business.toolName, arguments: { value: "hermes-shared" } } },
    ]);
    assert(hermesResults[0].items.some(item => item.id === sharedSkill.id));
    assert(hermesResults[0].items.some(item => item.id === pluginSkill.id));
    assert(hermesResults[0].items.some(item => item.serverId === business.serverId
      && item.name === business.toolName));
    assert.match(hermesResults[1].content, /Host probe/u);
    assert.match(hermesResults[2].content, /issue-summary/u);
    assert.equal(hermesResults[3].content, nativeFile.content);
    assert.equal(hermesResults[4].content, pluginFile.content);
    assert.equal(hermesResults[5].result.structuredContent.echoed, "hermes-shared");

    // Requirements are read from an exact machine declaration, while frozen
    // Codex-only workflows use reviewed source and converted-file hashes.
    const nativeEcho = await service.mcpProductToolController.executionContext.run(nativeScope,
      () => service.mcpProductToolController.handle("skill_catalog",
        { cursor: 0, limit: 10, query: "Echo workflow" }, nativeAuthority()));
    const echoEntry = nativeEcho.items.find(item => item.id === echoDescriptor.componentId);
    assert.equal(echoEntry?.eligible, true);
    assert.deepEqual(echoEntry.requiredTools, ["echo"]);
    assert.equal(echoEntry.assessment, "machine_declared");
    assert.match((await service.mcpProductToolController.executionContext.run(nativeScope,
      () => service.mcpProductToolController.handle("skill_read", {
        name: echoEntry.name, contentHash: echoEntry.contentHash,
        cursor: 0, maxBytes: 4_096 }, nativeAuthority()))).content,
    /Call the authorized echo tool/u);
    const openclawEcho = (await openclawInvoke(SEARCH, { query: "echo-workflow" })).items
      .find(item => item.id === echoDescriptor.componentId);
    assert.equal(openclawEcho?.eligible, true);
    assert.match((await openclawInvoke(READ, { skillId: openclawEcho.id })).content,
      /Call the authorized echo tool/u);
    const hermesEcho = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: "echo-workflow" } },
      { name: READ, args: { skillId: echoDescriptor.componentId } },
    ]);
    assert.equal(hermesEcho[0].items.find(item => item.id === echoDescriptor.componentId)?.eligible,
      true);
    assert.match(hermesEcho[1].content, /Call the authorized echo tool/u);

    // One real frozen Skill instructs the Agent to load ../../shared material.
    // The external API accepts a package-root-relative path instead of letting
    // an Agent traverse out of its Skill directory.
    const sharedPath = "shared/workflow-source-resolution.md";
    const frozenShared = fs.readFileSync(path.join(__dirname,
      "../resources/bundled-plugins/packages/public-equity-investing", sharedPath), "utf8");
    assert.match(frozenShared, /source|Source/u);
    const equityPreview = service.pluginPackageInstaller.previewBundled("public-equity-investing");
    assert(equityPreview.installable);
    const equityInstalled = service.pluginPackageInstaller.installBundled({
      packageId: "public-equity-investing", previewDigest: equityPreview.contentDigest,
      expectedRevision: equityPreview.expectedRevision,
      operationId: "three-host-frozen-public-equity-investing" });
    const equityDescriptor = service.pluginComponentResolver.listEnabledSkillDescriptors(profile.id)
      .find(item => item.sourceIdentity === "bundled:public-equity-investing"
        && item.name === "idea-generation");
    assert(equityDescriptor);
    const equityNative = service.runtimeSkillStore.catalog(profile.id).items
      .find(item => item.id === equityDescriptor.componentId);
    assert(equityNative?.eligible);
    const nativeShared = await service.mcpProductToolController.handle("plugin_resource_read",
      fileInput(equityNative, sharedPath), nativeAuthority());
    assert.equal(nativeShared.content, frozenShared);
    assert.equal(nativeShared.hasMore, false);
    assert.equal(nativeShared.fileHash,
      crypto.createHash("sha256").update(frozenShared).digest("hex"));
    const openclawEquity = (await openclawInvoke(SEARCH, { query: "idea-generation" })).items
      .find(item => item.id === equityDescriptor.componentId);
    assert.equal(openclawEquity?.eligible, true);
    const openclawShared = await openclawInvoke(RESOURCE_READ, {
      skillId: openclawEquity.id, relativePath: sharedPath });
    assert.equal(openclawShared.content, frozenShared);
    assert.equal(openclawShared.fileHash, nativeShared.fileHash);
    const hermesShared = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: "idea-generation" } },
      { name: RESOURCE_READ, args: { skillId: equityDescriptor.componentId,
        relativePath: sharedPath } },
    ]);
    assert.equal(hermesShared[0].items.find(item => item.id === equityDescriptor.componentId)?.eligible,
      true);
    assert.equal(hermesShared[1].content, frozenShared);
    assert.equal(hermesShared[1].fileHash, nativeShared.fileHash);
    await assert.rejects(service.mcpProductToolController.handle("plugin_resource_read",
      fileInput(equityNative, "../shared/workflow-source-resolution.md"), nativeAuthority()),
    error => error.code === "MCP_TOOL_INVALID_ARGUMENTS");
    await assert.rejects(openclawInvoke(RESOURCE_READ, { skillId: openclawEquity.id,
      relativePath: "skills/other/SKILL.md" }),
    error => error.code === "MCP_AUTH_FAILED");
    const installedShared = path.join(fixture.paths.pluginPackagesDir,
      equityInstalled.releaseDigest, sharedPath);
    fs.writeFileSync(installedShared, "Mutated after installation\n");
    await assert.rejects(openclawInvoke(RESOURCE_READ, { skillId: openclawEquity.id,
      relativePath: sharedPath }), error => error.code === "MCP_AUTH_FAILED");
    fs.writeFileSync(installedShared, frozenShared);
    assert.equal((await openclawInvoke(RESOURCE_READ, { skillId: openclawEquity.id,
      relativePath: sharedPath })).content, frozenShared);
    service.pluginStore.setInstallationDesiredState({
      installationId: equityInstalled.installationId, desiredState: "disabled",
      expectedRevision: equityInstalled.revision });
    await assert.rejects(service.mcpProductToolController.handle("plugin_resource_read",
      fileInput(equityNative, sharedPath), nativeAuthority()),
    error => error.code === "MCP_TOOL_NOT_FOUND");
    await assert.rejects(openclawInvoke(RESOURCE_READ, { skillId: openclawEquity.id,
      relativePath: sharedPath }), error => error.code === "CAPABILITY_FORBIDDEN");
    const hermesDisabledResource = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: RESOURCE_READ, args: { skillId: equityDescriptor.componentId,
        relativePath: sharedPath } },
    ]);
    assert.equal(hermesDisabledResource[0].code, "CAPABILITY_FORBIDDEN");

    for (const packageId of ["figma", "codex-security", "adobe"]) {
      const preview = service.pluginPackageInstaller.previewBundled(packageId);
      assert(preview.installable);
      service.pluginPackageInstaller.installBundled({ packageId,
        previewDigest: preview.contentDigest, expectedRevision: preview.expectedRevision,
        operationId: `three-host-frozen-${packageId}` });
    }
    const frozenDescriptors = service.pluginComponentResolver.listEnabledSkillDescriptors(profile.id);
    const figmaDescriptor = frozenDescriptors.find(item => item.name === "figma-design-to-code");
    const securityDescriptor = frozenDescriptors.find(item => item.name === "deep-security-scan");
    const adobeDescriptor = frozenDescriptors.find(item => item.name === "adobe-batch-edit-photos");
    assert.equal(figmaDescriptor?.descriptorDigest,
      "66b1ad8a1f72e5295c178548ced3c9dd4038432bb08e5f7a4617e399d59be9cd");
    assert.equal(securityDescriptor?.descriptorDigest,
      "c36e061938b2138d62e310145df05118dbf1b9a1e1ff12883928c92f32add636");
    assert.equal(adobeDescriptor?.descriptorDigest,
      "ad3d4aa4f4ed6245f2049ec1552af71df850ed5b9ce41cea2cb2bd8ee6f8ba48");
    const frozenNative = service.runtimeSkillStore.catalog(profile.id);
    const figmaNative = frozenNative.ineligible.find(item => item.id === figmaDescriptor.componentId);
    const securityNative = frozenNative.ineligible.find(item => item.id === securityDescriptor.componentId);
    const adobeNative = frozenNative.ineligible.find(item => item.id === adobeDescriptor.componentId);
    assert.equal(figmaNative?.reason, "tool_missing");
    assert.equal(figmaNative.dependency, "get_design_context");
    assert.equal(securityNative?.reason, "runtime_capability_missing");
    assert.equal(securityNative.dependency, "codex-security-plugin");
    assert.equal(adobeNative?.reason, "tool_contract_unverified");
    assert.equal(adobeNative.assessment, "declaration_unverified");
    const productFigma = await service.mcpProductToolController.handle("skill_catalog",
      { cursor: 0, limit: 10, query: "get_design_context" }, nativeAuthority());
    assert.equal(productFigma.items.find(item => item.id === figmaDescriptor.componentId)?.eligible,
      false);
    await assert.rejects(service.mcpProductToolController.handle("skill_read", {
      name: figmaNative.name, contentHash: figmaNative.contentHash,
      cursor: 0, maxBytes: 4_096 }, nativeAuthority()),
    error => error.code === "MCP_TOOL_NOT_FOUND");
    const openclawFigma = (await openclawInvoke(SEARCH,
      { query: "figma-design-to-code" })).items.find(item => item.id === figmaDescriptor.componentId);
    const openclawSecurity = (await openclawInvoke(SEARCH,
      { query: "deep-security-scan" })).items.find(item => item.id === securityDescriptor.componentId);
    const openclawAdobe = (await openclawInvoke(SEARCH,
      { query: "adobe-batch-edit-photos" })).items.find(item => item.id === adobeDescriptor.componentId);
    assert.equal(openclawFigma?.eligible, false);
    assert.equal(openclawFigma.reason, "tool_missing");
    assert.equal(openclawSecurity?.eligible, false);
    assert.equal(openclawSecurity.reason, "runtime_capability_missing");
    assert.equal(openclawAdobe?.eligible, false);
    assert.equal(openclawAdobe.reason, "tool_contract_unverified");
    await assert.rejects(openclawInvoke(READ, { skillId: openclawFigma.id }),
      error => error.code === "CAPABILITY_FORBIDDEN");
    const hermesFrozen = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: "figma-design-to-code" } },
      { name: SEARCH, args: { query: "deep-security-scan" } },
      { name: SEARCH, args: { query: "adobe-batch-edit-photos" } },
      { name: READ, args: { skillId: figmaDescriptor.componentId } },
    ]);
    assert.equal(hermesFrozen[0].items.find(item => item.id === figmaDescriptor.componentId)?.eligible,
      false);
    assert.equal(hermesFrozen[1].items.find(item => item.id === securityDescriptor.componentId)?.eligible,
      false);
    assert.equal(hermesFrozen[2].items.find(item => item.id === adobeDescriptor.componentId)?.eligible,
      false);
    assert.equal(hermesFrozen[2].items.find(item => item.id === adobeDescriptor.componentId)?.reason,
      "tool_contract_unverified");
    assert.equal(hermesFrozen[3].code, "CAPABILITY_FORBIDDEN");

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
    const revokedEcho = await service.mcpProductToolController.executionContext.run(nativeScope,
      () => service.mcpProductToolController.handle("skill_catalog",
        { cursor: 0, limit: 10, query: "Echo workflow" }, nativeAuthority()));
    assert.equal(revokedEcho.items.find(item => item.id === echoDescriptor.componentId)?.eligible,
      false);
    assert.equal(revokedEcho.items.find(item => item.id === echoDescriptor.componentId)?.reason,
      "tool_missing");
    const openclawRevokedEcho = (await openclawInvoke(SEARCH,
      { query: "echo-workflow" })).items.find(item => item.id === echoDescriptor.componentId);
    assert.equal(openclawRevokedEcho?.eligible, false);
    await assert.rejects(openclawInvoke(READ, { skillId: echoDescriptor.componentId }),
      error => error.code === "CAPABILITY_FORBIDDEN");
    const hermesRevokedEcho = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: "echo-workflow" } },
      { name: READ, args: { skillId: echoDescriptor.componentId } },
    ]);
    assert.equal(hermesRevokedEcho[0].items.find(item =>
      item.id === echoDescriptor.componentId)?.eligible, false);
    assert.equal(hermesRevokedEcho[1].code, "CAPABILITY_FORBIDDEN");
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
    await assert.rejects(service.mcpProductToolController.handle("skill_file_read",
      fileInput(nativeSkill, "references/host-guide.md"), nativeAuthority()),
    error => error.code === "MCP_TOOL_NOT_FOUND");
    assert.equal((await openclawInvoke(SEARCH, { query: SKILL_ID })).items.length, 0);
    await assert.rejects(openclawInvoke(FILE_READ, { skillId: sharedSkill.id,
      relativePath: "references/host-guide.md" }),
    error => error.code === "CAPABILITY_FORBIDDEN");
    const hermesDisabled = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: SKILL_ID } },
      { name: FILE_READ, args: { skillId: sharedSkill.id,
        relativePath: "references/host-guide.md" } },
    ]);
    assert.equal(hermesDisabled[0].items.length, 0);
    assert.equal(hermesDisabled[1].code, "CAPABILITY_FORBIDDEN");
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
