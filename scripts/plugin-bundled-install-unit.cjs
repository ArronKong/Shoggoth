"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginDependencyRegistry } = require("../app/agent-service/plugin-dependency-registry");
const { PluginMcpLaunchPlanner } = require("../app/agent-service/plugin-mcp-launch-planner");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { validatePluginManagementResult } = require("../app/core/plugin-management-dto");

function main() {
  const catalog = new BundledPluginCatalog(bundledRoot());
  const items = catalog.list().items;
  if (items.length === 0) {
    assert.equal(catalog.get("chatcut"), null);
    assert.equal(catalog.get("openai-developers"), null);
    console.log("public source without redistributed bundled packages: PASS");
    return;
  }
  assert.equal(items.length, 62);
  assert.equal(new Set(items.map(item => item.id)).size, 62);
  assert.equal(items.reduce((total, item) => total + item.unconvertedMcp.length, 0), 12);
  assert.deepEqual(catalog.get("github").unconvertedMcp, [{ name: "github",
    reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }]);
  for (const packageId of ["cloudflare", "creative-production", "data-analytics", "openai-developers"]) {
    assert.equal(catalog.get(packageId).converted.mcp, 1,
      `${packageId} must retain its representable MCP declaration`);
    assert.deepEqual(catalog.get(packageId).unconvertedMcp, []);
  }
  for (const item of items) catalog.assertCurrent(item.id);
  assert.equal(catalog.readIcon("github")?.mimeType, "image/png");
  assert.equal(catalog.readIcon("lovable"), null);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-bundled-plugin-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  let store;
  try {
    store = new PluginStore({ paths }).open();
    assert.deepEqual(store.listInstallations(), [], "bundled files must not install anything at startup");
    assert.deepEqual(fs.readdirSync(paths.pluginPackagesDir), [],
      "bundled files must not populate the managed package store at startup");
    const installer = new PluginPackageInstaller({ store, bundledCatalog: catalog });
    let discoveredSkills = 0;
    let convertedMcp = 0;
    let previewablePackages = 0;
    for (const item of items) {
      if (item.importStatus !== "previewable") {
        assert.throws(() => installer.previewBundled(item.id),
          { code: "BUNDLED_PLUGIN_ADAPTER_REQUIRED" });
        continue;
      }
      const packagePreview = installer.previewBundled(item.id);
      assert.equal(packagePreview.installable, true, `${item.id} must be previewable`);
      assert.equal(packagePreview.skills.length, item.components.skills,
        `${item.id} must retain every top-level Codex Skill`);
      const publicPreview = { sourceKind: "bundled", previewDigest: packagePreview.contentDigest,
        expectedRevision: packagePreview.expectedRevision, specVersion: packagePreview.specVersion,
        name: packagePreview.name, declaredVersion: packagePreview.declaredVersion,
        installable: packagePreview.installable,
        components: { skills: packagePreview.skills.map(skill => ({
          name: skill.name, description: skill.description,
          descriptorDigest: skill.descriptorDigest })),
        mcpServers: packagePreview.mcpServers }, diagnostics: packagePreview.diagnostics };
      assert.ok(Buffer.byteLength(JSON.stringify(publicPreview), "utf8") <= 48 * 1024,
        `${item.id} must fit the Service response limit`);
      validatePluginManagementResult("plugins.install.preview", publicPreview);
      discoveredSkills += packagePreview.skills.length;
      convertedMcp += packagePreview.mcpServers.length;
      assert.deepEqual(item.converted, { skills: packagePreview.skills.length,
        mcp: packagePreview.mcpServers.length },
      `${item.id} catalog coverage must match the install preview`);
      assert.deepEqual(item.unconvertedMcp, packagePreview.diagnostics
        .filter(issue => issue.scope === "mcp-server"
          && ["LEGACY_MCP_FIELD_UNSUPPORTED", "LEGACY_MCP_ENTRY_INVALID"].includes(issue.reasonCode))
        .map(({ name, reasonCode }) => ({ name, reasonCode })),
      `${item.id} catalog must explain every unconverted MCP declaration`);
      previewablePackages += 1;
    }
    assert.equal(previewablePackages, 52);
    assert.equal(discoveredSkills, 502);
    assert.equal(convertedMcp, 19);
    for (const packageId of ["cloudflare", "data-analytics"]) {
      assert.ok(installer.previewBundled(packageId).diagnostics.some(issue =>
        issue.reasonCode === "LEGACY_PRESENTATION_METADATA_OMITTED"),
      `${packageId} must disclose discarded presentation metadata`);
    }
    assert.deepEqual(store.listInstallations(), [], "catalog previews must never install packages");
    const preview = installer.previewBundled("chatcut");
    assert.equal(preview.installable, true);
    assert.equal(preview.skills.length, 1);
    assert.deepEqual(store.listInstallations(), [], "preview must not create an installation");
    const input = { packageId: "chatcut", previewDigest: preview.contentDigest,
      operationId: "bundled-install-chatcut", expectedRevision: preview.expectedRevision };
    const installed = installer.installBundled(input);
    assert.equal(installed.sourceIdentity, "bundled:chatcut");
    assert.equal(installed.desiredState, "enabled");
    assert.equal(installer.installBundled(input).installationId, installed.installationId,
      "replaying the same operation must return its prior receipt");
    const resolver = new PluginComponentResolver({ store });
    assert.equal(resolver.verifyInstallation(installed.installationId).releaseDigest,
      preview.contentDigest);
    const firstAgent = resolver.listEnabledSkillDescriptors("native-agent-a");
    const futureAgent = resolver.listEnabledSkillDescriptors("native-agent-b");
    assert.equal(firstAgent.length, 1);
    assert.deepEqual(firstAgent, futureAgent,
      "a future Agent must see the same installed Skill without another installation");
    assert.equal(resolver.inspectSkill(firstAgent[0]).name, "connect-chatcut-desktop");
    const disabled = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "disabled", expectedRevision: installed.revision });
    assert.equal(disabled.desiredState, "disabled");
    assert.deepEqual(resolver.listEnabledSkillDescriptors("native-agent-a"), []);
    const uninstall = { installationId: installed.installationId,
      expectedRevision: disabled.revision, operationId: "bundled-uninstall-chatcut" };
    assert.equal(installer.previewUninstall(uninstall).installationId, installed.installationId);
    installer.beginUninstall(uninstall);
    assert.equal(installer.uninstall(uninstall).packageRemoved, true);
    assert.deepEqual(store.listInstallations(), []);
    assert.equal(catalog.get("chatcut").importStatus, "previewable",
      "uninstall must keep the App's read-only installation source");
    const again = installer.previewBundled("chatcut");
    assert.equal(again.expectedRevision, store.getBySource("bundled:chatcut").revision,
      "reinstall must use the uninstalled record's next revision");
    const reinstalled = installer.installBundled({ packageId: "chatcut",
      previewDigest: again.contentDigest, expectedRevision: again.expectedRevision,
      operationId: "bundled-reinstall-chatcut" });
    assert.equal(reinstalled.desiredState, "enabled");
    assert.equal(resolver.listEnabledSkillDescriptors("native-agent-a").length, 1);
    assert.throws(() => installer.previewBundled("../chatcut"), { code: "BUNDLED_PLUGIN_NOT_FOUND" });
  } finally {
    store?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("bundled plugin opt-in installation and global native Skill fixture: PASS");
}

main();

function verifyBundledResourceUpgrade() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-bundled-upgrade-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  const source = (version, description) => {
    const root = path.join(temp, `app-resources-${version}`);
    fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "fixture"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "fixture", version, description: "Bundled upgrade fixture" }));
    fs.writeFileSync(path.join(root, "skills", "fixture", "SKILL.md"),
      `---\nname: fixture\ndescription: ${description}\n---\n${description}\n`);
    return root;
  };
  const catalog = root => ({
    assertCurrent(id) {
      assert.equal(id, "fixture");
      return { importStatus: "previewable" };
    },
    packagePath(id) { assert.equal(id, "fixture"); return root; },
  });
  const v1 = source("1.0.0", "First bundled generation");
  const v2 = source("2.0.0", "Second bundled generation");
  let store;
  try {
    store = new PluginStore({ paths }).open();
    const firstInstaller = new PluginPackageInstaller({ store, bundledCatalog: catalog(v1) });
    const firstPreview = firstInstaller.previewBundled("fixture");
    const first = firstInstaller.installBundled({ packageId: "fixture",
      previewDigest: firstPreview.contentDigest, expectedRevision: firstPreview.expectedRevision,
      operationId: "bundled-generation-one" });
    const nextInstaller = new PluginPackageInstaller({ store, bundledCatalog: catalog(v2) });
    const nextPreview = nextInstaller.previewBundled("fixture");
    assert.notEqual(nextPreview.contentDigest, first.releaseDigest);
    assert.equal(nextPreview.expectedRevision, first.revision);
    assert.throws(() => nextInstaller.installBundled({ packageId: "fixture",
      previewDigest: nextPreview.contentDigest, expectedRevision: nextPreview.expectedRevision,
      operationId: "bundled-update-while-enabled" }), { code: "PLUGIN_UPDATE_REQUIRES_DISABLE" });
    assert.equal(store.getInstallation(first.installationId).releaseDigest, first.releaseDigest,
      "a rejected update must leave the active package unchanged");
    const disabled = store.setInstallationDesiredState({ installationId: first.installationId,
      desiredState: "disabled", expectedRevision: first.revision });
    const ready = nextInstaller.previewBundled("fixture");
    assert.equal(ready.expectedRevision, disabled.revision);
    const updated = nextInstaller.installBundled({ packageId: "fixture",
      previewDigest: ready.contentDigest, expectedRevision: ready.expectedRevision,
      operationId: "bundled-generation-two" });
    assert.equal(updated.installationId, first.installationId);
    assert.equal(updated.releaseDigest, ready.contentDigest);
    assert.equal(updated.desiredState, "enabled");
    assert.equal(store.getRelease("bundled:fixture", first.releaseDigest)?.contentDigest,
      first.releaseDigest, "the prior immutable release remains available for controlled rollback");
    const resolver = new PluginComponentResolver({ store });
    assert.equal(resolver.listEnabledSkillDescriptors("native-future-agent").length, 1);
    assert.match(fs.readFileSync(path.join(paths.pluginPackagesDir, updated.releaseDigest,
      "skills", "fixture", "SKILL.md"), "utf8"), /Second bundled generation/u);
    const disabledAgain = store.setInstallationDesiredState({ installationId: updated.installationId,
      desiredState: "disabled", expectedRevision: updated.revision });
    const rollbackInstaller = new PluginPackageInstaller({ store, bundledCatalog: catalog(v1) });
    const rollbackPreview = rollbackInstaller.previewBundled("fixture");
    assert.equal(rollbackPreview.expectedRevision, disabledAgain.revision);
    assert.throws(() => rollbackInstaller.installBundled({ packageId: "fixture",
      previewDigest: rollbackPreview.contentDigest, expectedRevision: rollbackPreview.expectedRevision,
      operationId: "bundled-rollback-without-preview" }),
    { code: "PLUGIN_ROLLBACK_REQUIRES_PREVIEW" });
    assert.equal(store.getInstallation(first.installationId).releaseDigest, updated.releaseDigest);
  } finally {
    store?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("bundled App resource upgrade and rollback guard fixture: PASS");
}

verifyBundledResourceUpgrade();

async function verifyBundledLocalMcp() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-bundled-mcp-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  let store;
  let client;
  try {
    store = new PluginStore({ paths }).open();
    const installer = new PluginPackageInstaller({ store,
      bundledCatalog: new BundledPluginCatalog(bundledRoot()) });
    const preview = installer.previewBundled("openai-developers");
    const installed = installer.installBundled({ packageId: "openai-developers",
      previewDigest: preview.contentDigest, expectedRevision: preview.expectedRevision,
      operationId: "bundled-local-mcp-install" });
    const component = new PluginComponentCatalog({ store }).list()
      .find(item => item.installationId === installed.installationId)?.components
      .find(item => item.localName === "openai-api-key-local-confirmation");
    assert.ok(component, "the installed local MCP must enter the component catalog");
    const pin = { installationId: installed.installationId, componentId: component.componentId,
      releaseDigest: installed.releaseDigest, descriptorDigest: component.descriptorDigest };
    const disabled = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "disabled", expectedRevision: installed.revision });
    const dependencies = new PluginDependencyRegistry({ store });
    const dependencyPreview = dependencies.preview({ ...pin, executablePath: process.execPath });
    assert.equal(dependencyPreview.script, "./mcp/server.mjs");
    const prepared = dependencies.prepare({ ...pin, executablePath: process.execPath,
      previewDigest: dependencyPreview.previewDigest, expectedRevision: dependencyPreview.expectedRevision,
      operationId: "bundled-local-mcp-node", confirmed: true });
    assert.equal(prepared.status, "ready");
    store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: disabled.revision });
    const plan = new PluginMcpLaunchPlanner({ store, dependencies }).planStdio(pin);
    const leaseManager = new PluginDataScopeLeaseManager({ paths });
    client = await PluginMcpClient.connectStdio({ ...plan,
      connectionId: "bundled-local-mcp-fixture", principalIdentity: "local-fixture",
      authorizeEgress: () => true,
      dataScope: { leaseManager, installationId: installed.installationId,
        scopeId: "a".repeat(64) }, timeoutMs: 3000 });
    const tools = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ["confirm_openai_api_key_local_destination"]);
  } finally {
    await client?.close();
    store?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("bundled local MCP dependency, launch, and tool listing fixture: PASS");
}

if (new BundledPluginCatalog(bundledRoot()).list().items.length > 0) {
  verifyBundledLocalMcp().catch(error => { console.error(error); process.exitCode = 1; });
}
