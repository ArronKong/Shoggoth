"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");

const fixture = path.join(__dirname, "fixtures/plugins/project-assistant");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-resolver-"));
const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), trustedRoot: temp });
const store = new PluginStore({ paths }).open();

try {
  const source = path.join(temp, "source");
  fs.cpSync(fixture, source, { recursive: true });
  const installer = new PluginPackageInstaller({ store });
  const preview = installer.preview(source);
  const installed = installer.install({ sourcePath: source, previewDigest: preview.contentDigest,
    operationId: "resolver-install", expectedRevision: 0 });
  const resolver = new PluginComponentResolver({ store });
  const catalog = new PluginComponentCatalog({ store }).list()[0];
  const inputFor = (kind, name) => {
    const component = catalog.components.find((item) => item.kind === kind && item.localName === name);
    return { installationId: installed.installationId, releaseDigest: installed.releaseDigest,
      componentId: component.componentId, descriptorDigest: component.descriptorDigest };
  };
  const skillInput = inputFor("skill", "issue-summary");
  const stdioInput = inputFor("mcp-server", "local-issues");
  const httpInput = inputFor("mcp-server", "remote-issues");
  assert.throws(() => resolver.inspectSkill(skillInput),
    (error) => error.code === "PLUGIN_COMPONENT_INACTIVE");
  const enabled = store.setInstallationDesiredState({ installationId: installed.installationId,
    desiredState: "enabled", expectedRevision: installed.revision });
  assert.equal(enabled.desiredState, "enabled");
  assert.equal(resolver.listEnabledSkills("agent-a").length, 1);
  assert.equal(resolver.listEnabledSkills("agent-b").length, 1,
    "an enabled local package Skill is public to future profiles without a binding");
  const skillBinding = store.createSkillBinding({ bindingId: "agent-a-skill",
    profileId: "agent-a", installationId: installed.installationId,
    componentId: skillInput.componentId });
  assert.equal(skillBinding.componentKind, "skill");
  assert.equal(skillBinding.connectionId, null);
  assert.equal(resolver.listEnabledSkills("agent-a").length, 1,
    "a legacy disabled binding cannot hide a globally enabled Skill");
  assert.throws(() => store.createSkillBinding({ bindingId: "duplicate-skill",
    profileId: "agent-a", installationId: installed.installationId,
    componentId: skillInput.componentId }), (error) => error.code === "PLUGIN_BINDING_EXISTS");
  assert.throws(() => store.setGrant({ grantId: "skill-grant", bindingId: skillBinding.bindingId,
    toolIdentity: "echo", contractDigest: skillInput.descriptorDigest,
    effect: "allow", approvalMode: "always", expectedRevision: 0 }),
  (error) => error.code === "PLUGIN_GRANT_INVALID");
  store.setBindingEnabled({ bindingId: skillBinding.bindingId, enabled: true,
    expectedRevision: skillBinding.revision });
  assert.equal(resolver.listEnabledSkills("agent-a").length, 1);
  assert.equal(resolver.listEnabledSkills("agent-b").length, 1);

  const skill = resolver.inspectSkill(skillInput);
  assert.equal(skill.source, "plugin");
  assert.match(skill.content, /issue-summary/u);
  const stdio = resolver.inspectMcpServer(stdioInput);
  assert.equal(stdio.transport, "stdio");
  assert.deepEqual(stdio.spec.args, ["--data", "${PLUGIN_DATA}/issues"]);
  assert.equal(stdio.spec.command, "./bin/issue-fixture");
  const http = resolver.inspectMcpServer(httpInput);
  assert.equal(http.transport, "streamable-http");
  assert.equal(http.spec.url, "https://example.com/mcp");
  assert.equal(fs.existsSync(paths.skillRegistryPath), false,
    "read-only projection must not create a standalone Skill registry");
  assert.equal(fs.existsSync(paths.nativeMcpRegistryPath), false,
    "read-only projection must not create a standalone MCP registry");

  // Source edits do not affect the installed digest package.
  fs.appendFileSync(path.join(source, "skills/issue-summary/SKILL.md"), "\nsource edit\n");
  assert.equal(resolver.inspectSkill(skillInput).content, skill.content);
  const installedSkill = path.join(paths.pluginPackagesDir, installed.releaseDigest,
    "skills/issue-summary/SKILL.md");
  fs.appendFileSync(installedSkill, "\ninstalled edit\n");
  assert.throws(() => resolver.inspectSkill(skillInput),
    (error) => error.code === "PACKAGE_CHANGED");
  fs.copyFileSync(path.join(fixture, "skills/issue-summary/SKILL.md"), installedSkill);
  assert.equal(resolver.inspectSkill(skillInput).content, skill.content);
  fs.unlinkSync(installedSkill);
  assert.throws(() => resolver.inspectSkill(skillInput),
    (error) => error.code === "PACKAGE_CHANGED");
  fs.copyFileSync(path.join(fixture, "skills/issue-summary/SKILL.md"), installedSkill);
  const packageRoot = path.join(paths.pluginPackagesDir, installed.releaseDigest);
  fs.chmodSync(packageRoot, 0o755);
  assert.throws(() => resolver.inspectSkill(skillInput),
    (error) => error.code === "PACKAGE_CHANGED");
  fs.chmodSync(packageRoot, 0o700);

  const installedMcp = path.join(paths.pluginPackagesDir, installed.releaseDigest, "mcp.json");
  fs.appendFileSync(installedMcp, "\n");
  assert.throws(() => resolver.inspectMcpServer(httpInput),
    (error) => error.code === "PACKAGE_CHANGED");
  fs.copyFileSync(path.join(fixture, "mcp.json"), installedMcp);
  assert.equal(resolver.inspectMcpServer(httpInput).spec.url, http.spec.url);

  assert.throws(() => resolver.inspectMcpServer({ ...httpInput, descriptorDigest: "a".repeat(64) }),
    (error) => error.code === "PLUGIN_COMPONENT_REVISION_CHANGED");
  assert.throws(() => resolver.inspectSkill({ ...skillInput, releaseDigest: "b".repeat(64) }),
    (error) => error.code === "PLUGIN_COMPONENT_REVISION_CHANGED");
  store.setInstallationDesiredState({ installationId: installed.installationId,
    desiredState: "disabled", expectedRevision: enabled.revision });
  assert.deepEqual(resolver.listEnabledSkills("agent-a"), []);
  assert.throws(() => resolver.inspectMcpServer(stdioInput),
    (error) => error.code === "PLUGIN_COMPONENT_INACTIVE");

  // Updating a release cannot silently reactivate the old Skill selection.
  const changedPreview = installer.preview(source);
  const updated = installer.install({ sourcePath: source, previewDigest: changedPreview.contentDigest,
    operationId: "resolver-update", expectedRevision: enabled.revision + 1 });
  assert.equal(updated.desiredState, "disabled");
  assert.equal(store.getBinding(skillBinding.bindingId).enabled, false);
  store.setInstallationDesiredState({ installationId: updated.installationId,
    desiredState: "enabled", expectedRevision: updated.revision });
  assert.equal(resolver.listEnabledSkills("agent-a").length, 1);
  assert.throws(() => resolver.inspectSkill(skillInput),
    (error) => error.code === "PLUGIN_COMPONENT_REVISION_CHANGED");

  const updatedComponent = new PluginComponentCatalog({ store }).list()[0].components
    .find((item) => item.kind === "skill");
  store.setBindingEnabled({ bindingId: skillBinding.bindingId, enabled: true,
    expectedRevision: store.getBinding(skillBinding.bindingId).revision });
  const anotherSource = path.join(temp, "another-source");
  fs.cpSync(fixture, anotherSource, { recursive: true });
  const anotherPreview = installer.preview(anotherSource);
  const anotherInstallation = installer.install({ sourcePath: anotherSource,
    previewDigest: anotherPreview.contentDigest, operationId: "resolver-second-install",
    expectedRevision: 0 });
  store.setInstallationDesiredState({ installationId: anotherInstallation.installationId,
    desiredState: "enabled", expectedRevision: anotherInstallation.revision });
  const anotherComponent = new PluginComponentCatalog({ store }).list()
    .find((item) => item.installationId === anotherInstallation.installationId)
    .components.find((item) => item.kind === "skill");
  const anotherBinding = store.createSkillBinding({ bindingId: "agent-a-second-skill",
    profileId: "agent-a", installationId: anotherInstallation.installationId,
    componentId: anotherComponent.componentId });
  store.setBindingEnabled({ bindingId: anotherBinding.bindingId, enabled: true,
    expectedRevision: anotherBinding.revision });
  const selected = resolver.listEnabledSkills("agent-a");
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((item) => item.name), ["issue-summary", "issue-summary"]);
  assert.notEqual(selected[0].componentId, selected[1].componentId);
  assert(selected.some((item) => item.descriptorDigest === updatedComponent.descriptorDigest));
  assert.equal(resolver.listEnabledSkills("agent-b").length, 2);
  console.log("plugin component resolver: PASS");
} finally {
  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
