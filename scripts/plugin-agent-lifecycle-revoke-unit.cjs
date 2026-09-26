"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { JsonlProductStore } = require("../app/agent-service/product-store");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { createAgentLifecycleServiceController } = require(
  "../app/agent-service/agent-lifecycle-service-controller");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-agent-archive-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"),
    userDataRoot: root, profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const productStore = new JsonlProductStore({ paths, now: () => 10_000 });
  const pluginStore = new PluginStore({ paths });
  let controller;
  try {
    productStore.open();
    pluginStore.open();
    const installer = new PluginPackageInstaller({ store: pluginStore });
    const source = path.join(root, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source,
      { recursive: true });
    const preview = installer.preview(source);
    const installed = installer.install({ sourcePath: source,
      previewDigest: preview.contentDigest, operationId: "archive-install",
      expectedRevision: 0 });
    pluginStore.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const components = new PluginComponentCatalog({ store: pluginStore }).list()[0].components;
    const mcp = components.find((item) => item.localName === "local-issues");
    const skill = components.find((item) => item.localName === "issue-summary");
    assert(mcp && skill);
    const connection = pluginStore.createConnection({ connectionId: "shared-connection",
      installationId: installed.installationId, componentId: mcp.componentId,
      endpointIdentity: "fixture://shared" });
    const ready = pluginStore.setConnectionIdentity({
      connectionId: connection.connectionId, principalIdentity: "shared-account",
      state: "ready", expectedRevision: connection.revision });
    let failRevoke = true;
    controller = createAgentLifecycleServiceController({ productStore,
      runtimeManager: { async stop() {} },
      async initializeProfile() {}, async activateProfile() {},
      revokePluginProfile(profileId) {
        if (failRevoke) {
          failRevoke = false;
          throw new Error("fixture interrupted plugin transaction");
        }
        return pluginStore.revokeProfileBindings(profileId);
      },
      now: () => 10_000 });
    controller.open();
    const create = (id, name) => controller.handle("agent.create", {
      operationId: id, backendId: "shoggoth", name, defaultCwd: null,
      createdAt: 10_000 });
    const agentA = (await create("archive-agent-a", "Archive Agent A")).profile;
    const agentB = (await create("archive-agent-b", "Archive Agent B")).profile;
    const bind = (id, profileId) => {
      const binding = pluginStore.createBinding({ bindingId: id, profileId,
        installationId: installed.installationId, componentId: mcp.componentId,
        connectionId: ready.connectionId });
      const enabled = pluginStore.setBindingEnabled({ bindingId: id, enabled: true,
        expectedRevision: binding.revision });
      const grant = pluginStore.setGrant({ grantId: `grant-${id}`, bindingId: id,
        toolIdentity: "echo", contractDigest: crypto.createHash("sha256")
          .update("echo-v1").digest("hex"), effect: "allow",
        approvalMode: "always", expectedRevision: 0 });
      return { enabled, grant };
    };
    const bindingA = bind("binding-agent-a", agentA.id);
    const bindingB = bind("binding-agent-b", agentB.id);
    const skillA = pluginStore.createSkillBinding({ bindingId: "skill-agent-a",
      profileId: agentA.id, installationId: installed.installationId,
      componentId: skill.componentId });
    pluginStore.setBindingEnabled({ bindingId: skillA.bindingId, enabled: true,
      expectedRevision: skillA.revision });
    const archiveInput = { operationId: "archive-plugin-a", profileId: agentA.id,
      expectedUpdatedAt: agentA.updatedAt, createdAt: 10_000 };
    await assert.rejects(controller.handle("agent.archive", archiveInput),
      { code: "AGENT_PLUGIN_REVOKE_FAILED" });
    assert.equal(productStore.getAgentProfile(agentA.id).enabled, true,
      "a failed plugin transaction must leave the Agent active");
    assert.equal(pluginStore.getGrant(bindingA.enabled.bindingId, "echo").effect,
      "allow", "a failed plugin transaction remains visible until retry");
    assert.equal(productStore.listMcpToolCalls().find((call) => call.name === "agent.archive"
      && call.binding.targetProfileId === agentA.id).status, "pending");
    const archived = await controller.handle("agent.archive", archiveInput);
    assert.equal(archived.profile.enabled, false);
    assert.equal(pluginStore.getBinding(bindingA.enabled.bindingId).enabled, false);
    assert.equal(pluginStore.getBinding(skillA.bindingId).enabled, false);
    assert.equal(pluginStore.getGrant(bindingA.enabled.bindingId, "echo").effect,
      "deny");
    assert.equal(pluginStore.getBinding(bindingB.enabled.bindingId).revision,
      bindingB.enabled.revision);
    assert.equal(pluginStore.getGrant(bindingB.enabled.bindingId, "echo").revision,
      bindingB.grant.revision);
    assert.equal(pluginStore.getGrant(bindingB.enabled.bindingId, "echo").effect,
      "allow", "shared Connection must not transfer one Agent's revocation");
    const restoreInput = {
      operationId: "restore-plugin-a", profileId: agentA.id,
      expectedUpdatedAt: archived.profile.updatedAt, createdAt: 10_000 };
    failRevoke = true;
    await assert.rejects(controller.handle("agent.restore", restoreInput),
      { code: "AGENT_PLUGIN_REVOKE_FAILED" });
    assert.equal(productStore.getAgentProfile(agentA.id).enabled, false);
    const restored = await controller.handle("agent.restore", restoreInput);
    assert.equal(restored.profile.enabled, true);
    assert.equal(pluginStore.getBinding(bindingA.enabled.bindingId).enabled, false);
    assert.equal(pluginStore.getGrant(bindingA.enabled.bindingId, "echo").effect,
      "deny", "restore must not silently revive old plugin authority");
    console.log("plugin Agent archive/recovery local fixture: PASS");
  } finally {
    await controller?.close();
    pluginStore.close();
    productStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((failure) => { console.error(failure); process.exitCode = 1; });
