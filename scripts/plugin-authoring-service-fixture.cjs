"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { validateMcpProductToolArguments, isNativeOnlyMcpTool } = require("../app/agent-service/mcp-product-tool-controller");
const { shoggothProductDeveloperInstructions, SHOGGOTH_EXTERNAL_PRODUCT_DEVELOPER_INSTRUCTIONS } = require("../app/agent-service/product-capability-manifest");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-authoring-")));
  const fixture = createFixture(root, "openclaw");
  let service;
  let runId;
  try {
    service = await fixture.start();
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    const authority = (extra = {}) => ({ profileId: profile.id, callId: crypto.randomUUID(), ...extra });
    const invoke = (name, args, actor = authority()) => service.mcpProductToolController.handle(name, args, actor);
    for (const name of ["plugin_create", "plugin_install", "plugin_status"]) assert.equal(isNativeOnlyMcpTool(name), false);
    for (const instructions of [shoggothProductDeveloperInstructions(), SHOGGOTH_EXTERNAL_PRODUCT_DEVELOPER_INSTRUCTIONS]) {
      assert.match(instructions, /plugin_create/u);
      assert.match(instructions, /CLI path\/help\/output schema/u);
    }

    const skill = "---\nname: shared-echo\ndescription: Summarize an echo response using the shared MCP integration.\n---\n"
      + "# Shared echo\nUse the authorized echo MCP tool and summarize its structured result.\n";
    const files = [
      { path: "skills/shared-echo/SKILL.md", content: skill },
      { path: "skills/shared-echo/references/guide.md", content: "One shared installation for all three hosts.\n" },
      { path: ".mcp.json", content: JSON.stringify({ mcpServers: {
        echo: { command: "./server/echo", args: [], cwd: "." },
      } }) },
      { path: "server/mcp-sdk-fixture.cjs", content: fs.readFileSync(path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"), "utf8") },
      { path: "server/echo", executable: true, content: `#!${process.execPath}\n`
        + `const readline = require("node:readline");\nconst { handle } = require("./mcp-sdk-fixture.cjs");\n`
        + `readline.createInterface({ input: process.stdin }).on("line", line => {\n`
        + `  const response = handle(JSON.parse(line));\n`
        + `  if (response) process.stdout.write(JSON.stringify(response) + "\\n");\n});\n` },
    ];
    const input = { name: "shared-echo", description: "Shared plugin authoring fixture", files };
    for (const file of [{ path: "../escape", content: "x" }, { path: ".codex-plugin/plugin.json", content: "{}" },
      { path: "plugin.json", content: "{}" }, { path: "hooks/hooks.json", content: "{}" }]) {
      assert.equal(validateMcpProductToolArguments("plugin_create", { ...input, files: [file] }), false);
    }
    assert.equal(validateMcpProductToolArguments("plugin_create", { ...input,
      files: [{ path: "server/A", content: "a" }, { path: "server/a", content: "a" }] }), false);
    assert.equal(validateMcpProductToolArguments("plugin_status", { draftId: ["a".repeat(64)] }), false);
    await assert.rejects(invoke("plugin_create", { ...input, files: [
      { path: "skills/shared-echo/SKILL.md", content: `${skill}\napi_key = 'do-not-package-literal-credentials'\n` },
    ] }), error => error.code === "MCP_TOOL_SECRET_REJECTED");

    const creator = authority();
    const draft = await invoke("plugin_create", input, creator);
    assert.equal(draft.format, "codex-plugin");
    assert.equal(draft.installable, true, JSON.stringify(draft.diagnostics));
    assert.equal(draft.expectedRevision, 0);
    assert.equal(draft.installation, null);
    assert.equal(service.pluginStore.listInstallations().length, 0);
    assert.equal(service.pluginStore.listGlobalBindings().length, 0);
    assert.equal(fs.existsSync(path.join(draft.sourcePath, "plugin.json")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(draft.sourcePath, ".codex-plugin/plugin.json"), "utf8")).version, "0.1.0");
    assert.deepEqual(await invoke("plugin_create", input, creator), draft);
    await assert.rejects(invoke("plugin_status", { draftId: draft.draftId }, authority({ federationClient: "hermes" })),
      error => error.code === "MCP_TOOL_PATH_INVALID");
    const installArgs = { draftId: draft.draftId, previewDigest: draft.previewDigest,
      expectedRevision: draft.expectedRevision, enable: true };
    await assert.rejects(invoke("plugin_install", installArgs), error => error.code === "MCP_TOOL_CONFIRMATION_REQUIRED");
    assert.equal(service.pluginStore.listInstallations().length, 0);

    // The confirmed operation pins bytes, including supporting executable code.
    const guide = path.join(draft.sourcePath, "skills/shared-echo/references/guide.md");
    fs.appendFileSync(guide, "changed after preview\n");
    await assert.rejects(invoke("plugin_install", installArgs, authority({ confirmation: true })),
      error => error.code === "MCP_TOOL_STATE_CONFLICT");
    assert.equal(service.pluginStore.listInstallations().length, 0);
    fs.writeFileSync(guide, files[1].content);

    const installer = authority({ confirmation: true });
    const installed = await invoke("plugin_install", installArgs, installer);
    assert.equal(installed.installation.desiredState, "enabled");
    assert.equal(installed.components.filter(item => item.kind === "mcp-server")[0].state, "connection_required");
    assert.equal(service.pluginStore.listGlobalBindings().length, 0, "install must not grant or run MCP");
    const backend = new ShoggothBackend({ paths: fixture.paths });
    backend._profilesByAgent.set(profile.agentId, profile);
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 20, catalogRevision: null });
    assert(page.items.some(item => item.installationId === installed.installation.installationId
      && item.packageName === input.name), "same catalog consumed by Plugins UI must contain authored package");
    if (process.env.SHOGGOTH_TEST_AUTHORING_CATALOG) fs.writeFileSync(process.env.SHOGGOTH_TEST_AUTHORING_CATALOG,
      JSON.stringify(page), { mode: 0o600 });
    const nativeSkill = service.runtimeSkillStore.catalog(profile.id).items.find(item => item.name.startsWith("plugin-") && item.description.includes("shared-echo"));
    assert(nativeSkill);
    assert.match(service.runtimeSkillStore.read({ profileId: profile.id, name: nativeSkill.name,
      contentHash: nativeSkill.contentHash }).content, /# Shared echo/u);

    // Establish one real local MCP connection/grant through existing consent.
    const component = installed.components.find(item => item.kind === "mcp-server");
    const connect = await backend.preparePluginMcpConsent({ action: "connect", agentId: profile.agentId,
      installationId: installed.installation.installationId, componentId: component.componentId,
      expectedRevision: installed.installation.revision, operationId: "authoring-connect" });
    const connected = await backend.commitPluginMcpConsent({ challenge: connect.challenge, approved: true });
    const bindingId = connected.receipt.bindingId;
    await backend.discoverPluginMcpTools(profile.agentId, bindingId);
    const tools = await backend.getPluginMcpTools(profile.agentId, bindingId);
    const echo = tools.items.find(item => item.name === "echo");
    assert(echo);
    const allow = await backend.preparePluginMcpConsent({ action: "allow", agentId: profile.agentId,
      bindingId, toolIdentity: echo.toolIdentity, contractDigest: echo.contractDigest,
      catalogRevision: tools.catalogRevision, approvalMode: "always", expectedRevision: 0, operationId: "authoring-allow" });
    await backend.commitPluginMcpConsent({ challenge: allow.challenge, approved: true });
    const serverId = pluginServerId(bindingId);
    runId = crypto.randomUUID();
    service.workDispatcher.enqueue({ id: runId, source: "chat", sourceId: "authoring-chat",
      idempotencyKey: "authoring-native-run", profileId: profile.id, workspace: root });
    const admitted = service.workDispatcher.admit(runId, { writable: false });
    assert.equal(admitted.disposition, "started");
    assert.equal(service.pluginRuntimeToolService.captureRun(admitted.run).serverCount, 1);
    service.hookService.freezeRun(admitted.run, profile);
    service.workDispatcher.transition(runId, "running");
    const scope = { runId, assertCurrent() { assert.equal(service.workDispatcher.getRun(runId).status, "running"); } };
    const native = await service.pluginRuntimeToolService.callTool({ serverId, toolName: "echo", arguments: { value: "native" } }, authority(), scope);
    assert.equal(native.result.structuredContent.echoed, "native");
    for (const backendId of ["openclaw", "hermes"]) {
      const token = ensureCredential(fixture.paths, backendId);
      const external = async (method, args) => {
        const identity = { backendId, instanceId: `authoring-${backendId}`, agentId: `authoring-${backendId}-agent`,
          sessionId: "authoring-session", toolCallId: crypto.randomUUID(), ...(backendId === "openclaw"
            ? { runId: "authoring-run" } : { taskId: "authoring-task", turnId: "authoring-turn" }) };
        const lease = await service.externalPluginToolService.open({ credentialToken: token, identity });
        return service.externalPluginToolService[method]({ token: lease.token, identity, ...args });
      };
      const catalog = await external("search", { query: input.name });
      const shared = catalog.items.find(item => item.kind === "skill");
      assert(shared && shared.eligible);
      assert.equal((await external("readSkill", { skillId: shared.id })).content, skill);
      assert.equal((await external("call", { serverId, toolName: "echo", arguments: { value: backendId } })).result.structuredContent.echoed, backendId);
      const actor = authority({ federationClient: backendId });
      const externalDraft = await invoke("plugin_create", { name: `${backendId}-authored`, description: "External creator",
        files: [files[0]] }, actor);
      assert.equal(externalDraft.installable, true);
      const saved = await invoke("plugin_install", { draftId: externalDraft.draftId, previewDigest: externalDraft.previewDigest,
        expectedRevision: 0, enable: false }, authority({ federationClient: backendId, confirmation: true }));
      assert.equal(saved.installation.desiredState, "disabled");
    }
    assert.equal(service.pluginStore.listGlobalBindings().length, 1);
    assert.equal(service.pluginStore.getConnectionCountsForComponent(installed.installation.installationId, component.componentId).verified, 1);
    const fresh = await invoke("plugin_status", { draftId: draft.draftId });
    assert.equal(fresh.components.find(item => item.kind === "mcp-server").state, "ready");

    const unsupported = await invoke("plugin_create", { name: "unsupported-cli", description: "Unavailable CLI stays unavailable",
      files: [{ path: ".mcp.json", content: JSON.stringify({ mcpServers: { cli: { command: "nonexistent-product-cli" } } }) }] });
    assert.equal(unsupported.installable, false);
    assert(unsupported.diagnostics.some(item => item.reasonCode === "DEPENDENCY_INTERPRETER_UNSUPPORTED"));
    await assert.rejects(invoke("plugin_install", { draftId: unsupported.draftId, previewDigest: unsupported.previewDigest,
      expectedRevision: 0, enable: true }, authority({ confirmation: true })), error => error.code === "MCP_TOOL_STATE_CONFLICT");
    const empty = await invoke("plugin_create", { name: "empty-plugin", description: "Needs an actual component",
      files: [{ path: "README.md", content: "No executable capability\n" }] });
    assert.equal(empty.installable, false);
    const malformed = await invoke("plugin_create", { name: "broken-plugin", description: "Invalid Skill must be repaired",
      files: [{ path: "skills/broken/SKILL.md", content: "No YAML frontmatter\n" }] });
    assert.equal(malformed.installable, false);
    const partial = await invoke("plugin_create", { name: "partial-plugin", description: "Valid Skills cannot mask rejected MCP configuration",
      files: [files[0], { path: ".mcp.json", content: "{invalid JSON" }] });
    assert.equal(partial.installable, false);
    assert(partial.diagnostics.some(item => item.reasonCode === "LEGACY_MCP_CONFIG_INVALID"));

    // Receipt survives Service restart; status reflects user disable and exact
    // replay never broadens a later revoked package again.
    service.workDispatcher.transition(runId, "completed");
    runId = null;

    // Recreating a plugin by name updates the same draft and installation. An
    // enabled release is drained and replaced inside one confirmed install.
    const updateFiles = version => [{ path: "skills/update-demo/SKILL.md", content:
      `---\nname: update-demo\ndescription: Report the update fixture version.\n---\n# Update demo\nVersion ${version}.\n` },
    files[2], files[3], files[4]];
    const first = await invoke("plugin_create", { name: "update-demo", description: "Update fixture", files: updateFiles(1) });
    const firstInstall = await invoke("plugin_install", { draftId: first.draftId, previewDigest: first.previewDigest,
      expectedRevision: 0, enable: true }, authority({ confirmation: true }));
    const updateId = firstInstall.installation.installationId;
    assert.deepEqual(firstInstall.nextSteps, ["activate"]);
    const activated = await invoke("plugin_activate", { installationId: updateId,
      releaseDigest: firstInstall.installation.releaseDigest }, authority({ confirmation: true }));
    assert.deepEqual(activated.nextSteps, ["ready_next_turn"], JSON.stringify(activated));
    assert.deepEqual((await invoke("plugin_status", { draftId: first.draftId })).nextSteps, ["ready_next_turn"]);
    const second = await invoke("plugin_create", { name: "update-demo", description: "Update fixture",
      version: "0.2.0", files: updateFiles(2) });
    assert.equal(second.draftId, first.draftId);
    assert.equal(second.sourcePath, first.sourcePath);
    assert.notEqual(second.previewDigest, first.previewDigest);
    assert.deepEqual([second.installation.installationId, second.installation.declaredVersion], [updateId, "0.1.0"]);
    assert.deepEqual(second.nextSteps, ["confirm_install"]);
    assert.equal(second.expectedRevision, second.installation.revision);
    const updateArgs = { draftId: second.draftId, previewDigest: second.previewDigest,
      expectedRevision: second.expectedRevision, enable: true };
    const updater = authority({ confirmation: true });
    const updated = await invoke("plugin_install", updateArgs, updater);
    assert.deepEqual([updated.installation.installationId, updated.installation.releaseDigest, updated.installation.desiredState],
      [updateId, second.previewDigest, "enabled"]);
    assert.deepEqual(updated.nextSteps, ["activate"], "the new contract needs a fresh activation");
    assert.equal(service.pluginStore.listInstallations().filter(item => item.sourceIdentity
      === service.pluginStore.getInstallation(updateId).sourceIdentity).length, 1, "no duplicate installation");
    assert.equal(service.pluginStore.listGlobalBindings().filter(item => item.installationId === updateId && item.enabled).length, 0,
      "updating revokes the previous binding");
    assert.deepEqual((await invoke("plugin_install", updateArgs, updater)).installation, updated.installation, "exact replay");
    const reactivated = await invoke("plugin_activate", { installationId: updateId,
      releaseDigest: updated.installation.releaseDigest }, authority({ confirmation: true }));
    assert.deepEqual(reactivated.nextSteps, ["ready_next_turn"], JSON.stringify(reactivated));
    // Reverting to an earlier release's exact bytes is a rollback; it is
    // refused before the enabled installation is disabled.
    const reverted = await invoke("plugin_create", { name: "update-demo", description: "Update fixture", files: updateFiles(1) });
    assert.equal(reverted.previewDigest, first.previewDigest);
    await assert.rejects(invoke("plugin_install", { draftId: reverted.draftId, previewDigest: reverted.previewDigest,
      expectedRevision: reverted.expectedRevision, enable: true }, authority({ confirmation: true })),
    error => error.code === "PLUGIN_ROLLBACK_REQUIRES_PREVIEW");
    assert.equal(service.pluginStore.getInstallation(updateId).desiredState, "enabled");
    assert.equal(fs.readdirSync(path.dirname(first.sourcePath.replace(/\/package$/u, ""))).some(entry => entry.startsWith(".")),
      false, "no staging directories remain");

    await backend.setPluginInstallationState({ installationId: installed.installation.installationId,
      desiredState: "disabled", expectedRevision: installed.installation.revision, operationId: "authoring-disable" });
    service = await fixture.restart();
    const replay = await invoke("plugin_install", installArgs, installer);
    assert.equal(replay.installation.desiredState, "disabled");
    assert.equal(replay.installation.installationId, installed.installation.installationId);
    const creatorReplay = await invoke("plugin_create", { description: input.description, files, name: input.name }, creator);
    assert.equal(creatorReplay.draftId, draft.draftId);
    assert.equal(creatorReplay.installation.desiredState, "disabled");
    await assert.rejects(invoke("plugin_create", { ...input, description: "different operation" }, creator), error => error.code === "MCP_TOOL_STATE_CONFLICT");
    console.log("PASS plugin authoring: Codex default, confirmed pinned install, Plugins catalog, native/Hermes/OpenClaw shared Skill and real MCP, invalid inputs, restart/revocation replay");
  } finally {
    if (runId && service?.workDispatcher.getRun(runId)?.status === "running") {
      service.pluginRuntimeToolService.releaseRun(runId);
      service.workDispatcher.transition(runId, "completed");
    }
    await fixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
