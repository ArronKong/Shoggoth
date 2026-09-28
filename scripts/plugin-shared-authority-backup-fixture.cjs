#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAuthorityBackup, restoreAuthorityBackup, verifyAuthorityBackup } = require(
  "../app/agent-service/authority-backup");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { NativeSkillStore } = require("../app/agent-service/native-skill-store");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { buildPluginToolCatalog } = require("../app/agent-service/plugin-tool-contract");

function writePrivate(target, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode });
  fs.chmodSync(target, mode);
}

function restrictCopiedBackup(directory) {
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) restrictCopiedBackup(target);
    else if (entry.isFile()) fs.chmodSync(target, 0o600);
    else throw new Error(`Unexpected backup entry: ${target}`);
  }
}

function createSkillSource(root, name) {
  const source = path.join(root, "sources", "skills", name);
  writePrivate(path.join(source, "skill.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: name,
    name,
    version: "1.0.0",
    description: `${name} local backup fixture`,
    entry: "SKILL.md",
    requiredTools: [],
    requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth", "codex", "openclaw", "hermes"],
  })}\n`);
  writePrivate(path.join(source, "SKILL.md"), `# ${name}\n\nLocal backup fixture.\n`);
  return source;
}

function createMcpCommand(root) {
  const command = path.join(root, "sources", "mcp", "fixture-mcp");
  writePrivate(command, [
    "#!/usr/bin/env node",
    "'use strict';",
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    "rl.on('line', line => {",
    "  const request = JSON.parse(line);",
    "  if (!Object.hasOwn(request, 'id')) return;",
    "  if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'backup-fixture', version: '1' } } });",
    "  if (request.method === 'tools/list') return send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] } });",
    "  if (request.method === 'tools/call') return send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: request.params.arguments.value }] } });",
    "  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'not found' } });",
    "});",
    "",
  ].join("\n"), 0o700);
  return command;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-shared-authority-backup-"));
  // Keep the Service socket path below macOS's Unix-domain path limit.
  const otherRoot = fs.realpathSync(fs.mkdtempSync("/tmp/sgp-"));
  fs.chmodSync(root, 0o700);
  fs.chmodSync(otherRoot, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    userDataRoot: path.join(root, "user-data"),
    stateRoot: path.join(root, "user-data", "state"),
    profileRoot: path.join(root, "user-data", "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  let plugins;
  let skills;
  let mcp;
  let manager;
  let otherService;
  try {
    const command = createMcpCommand(root);
    const workspace = path.dirname(command);
    plugins = new PluginStore({ paths }).open();
    const pluginSource = path.join(__dirname, "fixtures", "plugins", "project-assistant");
    const installer = new PluginPackageInstaller({ store: plugins });
    const preview = installer.preview(pluginSource);
    let installation = installer.install({ sourcePath: pluginSource,
      previewDigest: preview.contentDigest, operationId: "backup-fixture-install", expectedRevision: 0 });
    installation = plugins.setInstallationDesiredState({ installationId: installation.installationId,
      desiredState: "enabled", expectedRevision: installation.revision });
    const selectedComponentId = componentId(installation.installationId, "mcp-server", "local-issues");
    let connection = plugins.createConnection({ connectionId: "backup-fixture-connection",
      installationId: installation.installationId, componentId: selectedComponentId,
      endpointIdentity: "fixture://local-only" });
    connection = plugins.setConnectionIdentity({ connectionId: connection.connectionId,
      principalIdentity: "fixture-local-account", state: "ready", expectedRevision: connection.revision });
    let binding = plugins.createGlobalBinding({ bindingId: "backup-fixture-binding",
      installationId: installation.installationId, componentId: selectedComponentId,
      connectionId: connection.connectionId });
    binding = plugins.setBindingEnabled({ bindingId: binding.bindingId, enabled: true,
      expectedRevision: binding.revision });
    const catalog = buildPluginToolCatalog({ installationId: installation.installationId,
      componentId: selectedComponentId, connectionId: connection.connectionId,
      tools: [{ name: "echo", inputSchema: { type: "object" } }] });
    const tool = catalog.entries[0];
    plugins.setGrant({ grantId: "backup-fixture-grant", bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: 0 });

    skills = new NativeSkillStore({ paths, profileExists: () => true }).open(["profile-a", "profile-b"]);
    for (const [name, globalEnabled] of [["shared-note", true], ["paused-note", false]]) {
      skills.installFromDirectory({ sourcePath: createSkillSource(root, name), globalEnabled,
        expectedRevision: skills.revision, operationId: `install-${name}` });
    }
    assert.deepEqual(skills.listGlobalEnabled().map(item => item.name), ["shared-note"]);
    mcp = new NativeMcpStore({ paths }).open();
    for (const [id, enabled] of [["shared-echo", true], ["paused-echo", false]]) {
      mcp.register({ expectedRevision: mcp.revision,
        server: mcp.prepare({ id, name: id, command, args: [], cwd: workspace, enabled }) });
    }
    assert.deepEqual(mcp.list().servers.map(item => [item.id, item.enabled]),
      [["paused-echo", false], ["shared-echo", true]]);
    plugins.close(); plugins = null;
    skills.close(); skills = null;
    mcp.close(); mcp = null;

    writePrivate(path.join(paths.pluginStagingDir, "abandoned", "uncommitted.txt"), "not authority\n");
    writePrivate(path.join(paths.skillStagingDir, "abandoned", "uncommitted.txt"), "not authority\n");
    const backupId = "shared-authority-fixture";
    const backup = createAuthorityBackup({ paths, backupId });
    const verified = verifyAuthorityBackup({ paths, backupId });
    assert.equal(verified.manifest.rootDigest, backup.manifest.rootDigest);
    const entries = verified.manifest.entries.map(item => item.path);
    for (const expected of ["plugins/catalog.sqlite", "skills/registry.json",
      "skills/packages/shared-note/1.0.0/SKILL.md", "skills/packages/paused-note/1.0.0/SKILL.md",
      "mcp-servers/registry.json"]) {
      assert(entries.includes(expected), `${expected} must be backed up`);
    }
    assert(entries.some(item => item.startsWith("plugins/packages/")));
    assert.equal(entries.some(item => item === "plugins/staging" || item.startsWith("plugins/staging/")), false);
    assert.equal(entries.some(item => item === "skills/staging" || item.startsWith("skills/staging/")), false);

    // Advance the live registries after the snapshot so restored state cannot
    // accidentally be satisfied by reopening the original Store directories.
    skills = new NativeSkillStore({ paths, profileExists: () => true }).open(["profile-a"]);
    skills.setGlobalSkill({ skillId: "shared-note", source: "user", version: "1.0.0",
      enabled: false, expectedRevision: skills.revision });
    skills.setGlobalSkill({ skillId: "paused-note", source: "user", version: "1.0.0",
      enabled: true, expectedRevision: skills.revision });
    skills.close(); skills = null;
    mcp = new NativeMcpStore({ paths }).open();
    mcp.register({ expectedRevision: mcp.revision,
      server: mcp.prepare({ id: "shared-echo", name: "shared-echo", command,
        args: [], cwd: workspace, enabled: false }) });
    mcp.register({ expectedRevision: mcp.revision,
      server: mcp.prepare({ id: "paused-echo", name: "paused-echo", command,
        args: [], cwd: workspace, enabled: true }) });
    mcp.close(); mcp = null;

    const destinationStateDir = path.join(root, "restored-state");
    const restored = restoreAuthorityBackup({ paths, backupId, destinationStateDir });
    assert.equal(restored.destinationStateDir, destinationStateDir);
    assert(restored.pluginRestore, "plugin authority must rotate on restore");
    assert.deepEqual(restored.nativeMcpRestore, { disabled: 1, retained: 2 },
      "restored local executables require an explicit rebind even on the same machine");
    assert.equal(fs.existsSync(path.join(destinationStateDir, "plugins", "staging",
      "abandoned", "uncommitted.txt")), false);
    assert.equal(fs.existsSync(path.join(destinationStateDir, "skills", "staging",
      "abandoned", "uncommitted.txt")), false);
    const restoredPaths = resolveServicePaths({ trustedRoot: root,
      userDataRoot: path.join(root, "restored-user-data"), stateRoot: destinationStateDir });
    plugins = new PluginStore({ paths: restoredPaths }).open();
    assert.equal(plugins.getInstallation(installation.installationId).desiredState, "disabled");
    assert.equal(plugins.getConnection(connection.connectionId).state, "disconnected");
    assert.equal(plugins.getBinding(binding.bindingId).enabled, false);
    assert.equal(plugins.getGrant(binding.bindingId, tool.toolIdentity).effect, "deny");
    skills = new NativeSkillStore({ paths: restoredPaths, profileExists: () => true })
      .open(["profile-a", "profile-b"]);
    for (const profileId of ["profile-a", "profile-b"]) {
      assert.deepEqual(skills.list(profileId).items.map(item => [item.name, item.enabled]),
        [["paused-note", false], ["shared-note", true]]);
    }
    const shared = skills.listGlobalEnabled()[0];
    assert.match(skills.readGlobalEnabled({ skillId: shared.id, version: shared.version,
      contentHash: shared.contentHash, registryRevision: shared.registryRevision }).content,
    /Local backup fixture/u);
    mcp = new NativeMcpStore({ paths: restoredPaths }).open();
    assert.deepEqual(mcp.list().servers.map(item => [item.id, item.enabled]),
      [["paused-echo", false], ["shared-echo", false]]);
    manager = new NativeMcpClientManager({ store: mcp });
    await assert.rejects(() => manager.listTools("shared-echo"), { code: "MCP_SERVER_NOT_FOUND" });
    mcp.register({ expectedRevision: mcp.revision,
      server: mcp.prepare({ id: "shared-echo", name: "shared-echo", command,
        args: [], cwd: workspace, enabled: true }) });
    assert.deepEqual((await manager.listTools("shared-echo")).map(item => item.name), ["echo"]);
    assert.deepEqual(await manager.callTool("shared-echo", "echo", { value: "restored" }),
      { content: [{ type: "text", text: "restored" }] });
    await manager.close(); manager = null;
    plugins.close(); plugins = null;
    skills.close(); skills = null;
    mcp.close(); mcp = null;

    // Move the verified snapshot to a different trusted root. The source
    // machine's absolute MCP path is outside that root and cannot be started.
    const otherPaths = resolveServicePaths({ trustedRoot: otherRoot,
      userDataRoot: path.join(otherRoot, "user-data"),
      stateRoot: path.join(otherRoot, "user-data", "state"),
      profileRoot: path.join(otherRoot, "user-data", "profile"),
      cacheRoot: path.join(otherRoot, "cache") });
    fs.mkdirSync(otherPaths.backupsDir, { recursive: true, mode: 0o700 });
    fs.cpSync(backup.backupPath, path.join(otherPaths.backupsDir, backupId), { recursive: true });
    restrictCopiedBackup(path.join(otherPaths.backupsDir, backupId));
    assert.equal(verifyAuthorityBackup({ paths: otherPaths, backupId }).manifest.rootDigest,
      backup.manifest.rootDigest);
    const otherRestored = restoreAuthorityBackup({ paths: otherPaths, backupId,
      destinationStateDir: path.join(otherRoot, "restored-state") });
    assert.deepEqual(otherRestored.nativeMcpRestore, { disabled: 1, retained: 2 });
    const otherRestoredPaths = resolveServicePaths({ trustedRoot: otherRoot,
      stateRoot: otherRestored.destinationStateDir,
      userDataRoot: path.join(otherRoot, "restored-user-data"),
      profileRoot: path.join(otherRoot, "restored-user-data", "profile"),
      cacheRoot: path.join(otherRoot, "cache") });
    mcp = new NativeMcpStore({ paths: otherRestoredPaths }).open();
    assert.equal(mcp.get("shared-echo").command, command,
      "old path remains visible so the user can identify what needs repair");
    assert.equal(mcp.get("shared-echo").enabled, false);
    manager = new NativeMcpClientManager({ store: mcp });
    await assert.rejects(() => manager.listTools("shared-echo"), { code: "MCP_SERVER_NOT_FOUND" });
    assert.throws(() => mcp.register({ expectedRevision: mcp.revision,
      server: { id: "shared-echo", name: "shared-echo", command,
        args: [], cwd: workspace, enabled: true } }), { code: "MCP_SERVER_PATH_INVALID" });
    await manager.close(); manager = null;
    mcp.close(); mcp = null;
    otherService = createAgentService({ paths: otherRestoredPaths, parentEnv: {},
      prewarmMcpAuth: false, version: "portable-authority-fixture" });
    await otherService.start();
    assert.equal(otherService.nativeMcpStore.get("shared-echo").enabled, false,
      "the Service must start before any machine-local MCP path is repaired");
    await otherService.stop({ notify: false }); otherService = null;
    mcp = new NativeMcpStore({ paths: otherRestoredPaths }).open();
    manager = new NativeMcpClientManager({ store: mcp });
    const otherCommand = createMcpCommand(otherRoot);
    mcp.register({ expectedRevision: mcp.revision,
      server: mcp.prepare({ id: "shared-echo", name: "shared-echo", command: otherCommand,
        args: [], cwd: path.dirname(otherCommand), enabled: true }) });
    assert.deepEqual((await manager.listTools("shared-echo")).map(item => item.name), ["echo"]);
    await manager.close(); manager = null;
    mcp.close(); mcp = null;

    fs.appendFileSync(path.join(backup.backupPath, "payload", "skills", "packages",
      "shared-note", "1.0.0", "SKILL.md"), "tampered\n");
    assert.throws(() => verifyAuthorityBackup({ paths, backupId }), { code: "BACKUP_CORRUPT" });
    const deniedDestination = path.join(root, "corrupt-restore-denied");
    assert.throws(() => restoreAuthorityBackup({ paths, backupId,
      destinationStateDir: deniedDestination }), { code: "BACKUP_CORRUPT" });
    assert.equal(fs.existsSync(deniedDestination), false);
    console.log("PASS shared plugin/Skill/MCP authority backup, restored state, and corrupt Skill fail-closed");
  } finally {
    if (manager) await manager.close();
    await otherService?.stop({ notify: false });
    plugins?.close();
    skills?.close();
    mcp?.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
