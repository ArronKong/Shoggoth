"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const SKILL_ID = "shoggoth-host-probe-skill";

function createFixture(root, backendId, serviceOptions = {}) {
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "service"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const source = path.join(root, "skill-source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "skill.json"), `${JSON.stringify({
    schemaVersion: 1, id: SKILL_ID, name: SKILL_ID, version: "1.0.0",
    description: "Isolated host to Service capability fixture",
    entry: "SKILL.md", requiredTools: [], requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth", "openclaw", "hermes"],
  })}\n`);
  fs.writeFileSync(path.join(source, "SKILL.md"),
    "# Host probe\nRead this installed public Skill only through Shoggoth Service.\n");
  const credential = ensureCredential(paths, backendId);
  let service = null;
  const start = async () => {
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "plugin-real-host-service-fixture",
      ...serviceOptions });
    await service.start();
    return service;
  };
  return {
    paths, credential,
    async start() { return start(); },
    listAuditedCalls(backendId, cursor = null, limit = 20) {
      return new ShoggothBackend({ paths }).getPluginExternalCalls({ backendId, cursor, limit });
    },
    install() {
      const installed = service.nativeSkillStore.installFromDirectory({
        operationId: "host-probe-install", sourcePath: source,
        expectedRevision: service.nativeSkillStore.revision, globalEnabled: true,
      });
      return { ...installed, componentId: crypto.createHash("sha256")
        .update(JSON.stringify(["native-skill", SKILL_ID, "1.0.0",
          installed.package.contentHash])).digest("hex") };
    },
    async installMcpTool() {
      const pluginSource = path.join(root, "plugin-source");
      fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), pluginSource,
        { recursive: true });
      fs.copyFileSync(path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"),
        path.join(pluginSource, "bin", "mcp-sdk-fixture.cjs"));
      fs.writeFileSync(path.join(pluginSource, "bin", "issue-fixture"),
        `#!${process.execPath}\nconst readline = require("node:readline");\n`
        + `const { handle } = require("./mcp-sdk-fixture.cjs");\n`
        + `readline.createInterface({ input: process.stdin }).on("line", line => {\n`
        + `  const response = handle(JSON.parse(line));\n`
        + `  if (response) process.stdout.write(JSON.stringify(response) + "\\n");\n`
        + `});\n`, { mode: 0o700 });
      fs.chmodSync(path.join(pluginSource, "bin", "issue-fixture"), 0o700);
      const backend = new ShoggothBackend({ paths });
      const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
      if (!profile) throw new Error("isolated Service has no native Profile");
      backend._profilesByAgent.set(profile.agentId, profile);
      const source = { kind: "directory", path: pluginSource };
      const preview = await backend.previewPluginInstall(source);
      if (!preview.installable) throw new Error("fixture MCP plugin cannot install");
      const installed = await backend.installPlugin({ source, previewDigest: preview.previewDigest,
        expectedRevision: preview.expectedRevision, operationId: "host-mcp-install" });
      const enabled = await backend.setPluginInstallationState({
        installationId: installed.installation.installationId,
        desiredState: "enabled", expectedRevision: installed.installation.revision,
        operationId: "host-mcp-enable",
      });
      const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
        catalogRevision: null });
      const item = page.items.find(row => row.installationId === installed.installation.installationId);
      const component = item?.components.find(row => row.localName === "local-issues");
      if (!component) throw new Error("fixture local MCP component missing");
      const prepared = await backend.preparePluginMcpConsent({ action: "connect",
        agentId: profile.agentId, installationId: item.installationId,
        componentId: component.componentId, expectedRevision: enabled.installation.revision,
        operationId: "host-mcp-connect" });
      const connected = await backend.commitPluginMcpConsent({ challenge: prepared.challenge,
        approved: true });
      const bindingId = connected.receipt.bindingId;
      await backend.discoverPluginMcpTools(profile.agentId, bindingId);
      const catalog = await backend.getPluginMcpTools(profile.agentId, bindingId);
      const tool = catalog.items.find(row => row.name === "echo");
      if (!tool) throw new Error("fixture MCP echo tool missing");
      const grant = await backend.preparePluginMcpConsent({ action: "allow",
        agentId: profile.agentId, bindingId, toolIdentity: tool.toolIdentity,
        contractDigest: tool.contractDigest, catalogRevision: catalog.catalogRevision,
        approvalMode: "always", expectedRevision: 0, operationId: "host-mcp-grant" });
      await backend.commitPluginMcpConsent({ challenge: grant.challenge, approved: true });
      const granted = await backend.getPluginMcpTools(profile.agentId, bindingId);
      let grantRevision = granted.items.find(row => row.name === "echo")?.savedGrant?.revision;
      if (!Number.isSafeInteger(grantRevision)) throw new Error("fixture MCP Grant missing");
      return { serverId: pluginServerId(bindingId), toolName: "echo",
        installationId: item.installationId,
        installationRevision: enabled.installation.revision,
        bindingId, toolIdentity: tool.toolIdentity,
        async requireEachCall() {
          const prepared = await backend.preparePluginMcpConsent({ action: "allow",
            agentId: profile.agentId, bindingId, toolIdentity: tool.toolIdentity,
            contractDigest: tool.contractDigest, catalogRevision: catalog.catalogRevision,
            approvalMode: "each-call", expectedRevision: grantRevision,
            operationId: "host-mcp-each-call" });
          await backend.commitPluginMcpConsent({ challenge: prepared.challenge, approved: true });
          const updated = await backend.getPluginMcpTools(profile.agentId, bindingId);
          grantRevision = updated.items.find(row => row.name === "echo")?.savedGrant?.revision;
          if (!Number.isSafeInteger(grantRevision)) throw new Error("fixture each-call Grant missing");
        },
        revoke: () => backend.revokePluginMcpGrant({ agentId: profile.agentId, bindingId,
          toolIdentity: tool.toolIdentity, expectedRevision: grantRevision,
          operationId: "host-mcp-revoke" }) };
    },
    disable() {
      return service.nativeSkillStore.setGlobalSkill({ source: "user", skillId: SKILL_ID,
        version: "1.0.0", enabled: false,
        expectedRevision: service.nativeSkillStore.revision });
    },
    listPendingApprovals(backendId) {
      return new ShoggothBackend({ paths }).getExternalPluginApprovals({ backendId });
    },
    async respondApproval(requestId, approved) {
      const backend = new ShoggothBackend({ paths });
      const prepared = await backend.prepareExternalPluginApproval({ requestId,
        operationId: `host-approval-${crypto.randomUUID()}`,
        decision: approved ? "once" : "deny" });
      if (prepared.completed) throw new Error("fixture external approval already completed");
      if (prepared.summary.requestId !== requestId
        || prepared.summary.toolName !== "echo"
        || JSON.parse(prepared.summary.command).value !== "host-business") {
        throw new Error("fixture external approval summary mismatch");
      }
      return backend.commitExternalPluginApproval({ challenge: prepared.challenge, approved });
    },
    stallNextCall() {
      const tools = service.externalPluginToolService;
      const originalCall = tools.call.bind(tools);
      const originalCancel = tools.cancel.bind(tools);
      let enteredResolve;
      let canceledResolve;
      let releaseResolve;
      let cancelCount = 0;
      const entered = new Promise(resolve => { enteredResolve = resolve; });
      const canceled = new Promise(resolve => { canceledResolve = resolve; });
      const hold = new Promise(resolve => { releaseResolve = resolve; });
      tools.call = async params => {
        enteredResolve(params);
        await hold;
        // A canceled lease must remain unusable after its host socket closes.
        return originalCall(params);
      };
      tools.cancel = params => {
        cancelCount += 1;
        try {
          const result = originalCancel(params);
          canceledResolve({ params, errorCode: null });
          return result;
        } catch (error) {
          canceledResolve({ params, errorCode: error.code || error.message });
          throw error;
        } finally { releaseResolve(); }
      };
      return { entered, canceled, get cancelCount() { return cancelCount; }, release() {
        releaseResolve();
        tools.call = originalCall;
        tools.cancel = originalCancel;
      } };
    },
    async restart() { await service.stop(); service = null; return start(); },
    async stop() { if (service) await service.stop(); service = null; },
  };
}

module.exports = { createFixture, SKILL_ID };
