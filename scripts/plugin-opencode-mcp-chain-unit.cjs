#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAgentService } = require("../app/agent-service/server");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { OpenCodeRuntimePool } = require("../app/agent-service/opencode-runtime-pool");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginDependencyRegistry } = require("../app/agent-service/plugin-dependency-registry");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgo-"));
  const userInfo = () => ({ homedir: root });
  const paths = resolveCanonicalServicePaths({ userInfo });
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
  const fixture = path.join(__dirname, "fixtures/opencode-mcp-local.cjs");
  const issuer = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: process.execPath, argsPrefix: [] } });
  const spawned = [];
  const pool = new OpenCodeRuntimePool({ paths, mcpGateIssuer: issuer,
    parentEnv: { PATH: path.dirname(process.execPath) },
    runtimeAccountResolver: { resolve: binding => Object.freeze({ runtime: "opencode",
      runtimeAccountId: binding.runtimeAccountId, home: root, binaryPath: process.execPath,
      configSourceHome: root, configurationMode: "native", launchArgs: Object.freeze([]),
      spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }) },
    spawnProcess(command, args, options) {
      assert.equal(command, process.execPath);
      const child = spawn(command, [fixture, args[0] === "--version" ? "version" : "serve", root], options);
      spawned.push(child); return child;
    },
  });
  const service = createAgentService({ paths, runtimeMcpGateIssuer: issuer, openCodeRuntimePool: pool,
    builtinCliProfiles: true, version: "offline-opencode-chain", parentEnv: {},
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString() } });
  try {
    await service.start();
    const profile = service.productStore.listAgentProfiles().find(value => value.runtime === "opencode");
    assert(profile);
    const installer = new PluginPackageInstaller({ store: service.pluginStore });
    const sourcePath = path.resolve(__dirname, "../examples/plugins/local-notes");
    const preview = installer.preview(sourcePath);
    const installed = installer.install({ sourcePath, previewDigest: preview.contentDigest,
      expectedRevision: 0, operationId: "chain-install" });
    const component = new PluginComponentCatalog({ store: service.pluginStore }).list()[0].components
      .find(value => value.localName === "notes");
    const pin = { installationId: installed.installationId, releaseDigest: installed.releaseDigest,
      componentId: component.componentId, descriptorDigest: component.descriptorDigest };
    const dependencies = new PluginDependencyRegistry({ store: service.pluginStore });
    const dependency = dependencies.preview({ ...pin, executablePath: process.execPath });
    dependencies.prepare({ ...pin, executablePath: process.execPath, previewDigest: dependency.previewDigest,
      expectedRevision: 0, operationId: "chain-node", confirmed: true });
    const installation = service.pluginStore.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const connect = await service.pluginMcpConsent.prepare({ action: "connect", profileId: profile.id,
      installationId: installed.installationId, componentId: component.componentId,
      expectedRevision: installation.revision, operationId: "chain-connect" });
    const connected = await service.pluginMcpConsent.commit({ challenge: connect.challenge, approved: true });
    const bindingId = connected.receipt.bindingId;
    const records = service.pluginStore.getCapabilityRecords(bindingId, "__projection__");
    const client = await service.pluginMcpConnectionManager.acquire(records);
    const catalog = await service.pluginToolCatalogRegistry.refresh({ ...records, client }); await client.release();
    for (const tool of catalog.entries) service.pluginStore.setGrant({ grantId: `chain-${tool.downstreamName}`,
      bindingId, toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      effect: "allow", approvalMode: tool.downstreamName === "write_note" ? "each-call" : "always", expectedRevision: 0 });
    const session = service.chatSessionStore.createSession({ profileId: profile.id, workspace,
      operationId: "chain-session", createdAt: Date.now() });
    const begin = async id => {
      const ack = await service.workRunCoordinator.send({ operationId: id, sessionKey: session.sessionKey,
        prompt: "offline fixture" });
      await service.workRunCoordinator.waitForIdle(ack.run.id);
      const run = service.workRunCoordinator.getRun(ack.run.id);
      assert.equal(run.status, "running", JSON.stringify(run));
      const entry = [...pool.entries.values()].find(value => value.host.mcpExecutionRunId === run.id);
      assert(entry, "Coordinator execution contract must reach the actual OpenCode Pool/Host");
      assert.equal((await entry.host.client.request("GET", "/fixture/ready")).data.pid, entry.host.child.pid);
      return { run, host: entry.host };
    };
    const first = await begin("chain-run-1");
    const events = [];
    service.workRunCoordinator.subscribeRun(first.run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    const call = async (host, name, args = {}) => (await host.client.request("POST", "/fixture/call",
      { name, arguments: args }, { timeoutMs: 10000 })).data;
    const status = await call(first.host, "app_status"); assert.equal(status.result?.isError, false, JSON.stringify(status));
    const serverId = pluginServerId(bindingId);
    const list = await call(first.host, "mcp_server_list");
    assert(JSON.stringify(list).includes(serverId));
    const read = await call(first.host, "mcp_server_call", { serverId, toolName: "read_note", arguments: {} });
    assert.equal(read.result?.isError, false, JSON.stringify(read));
    assert(JSON.stringify(read).includes("shoggothPluginApp"), "native bridge returns an App call receipt");
    await waitUntil(() => events.some(event => event.type === "tool.result"
      && event.payload.tool?.name === "shoggoth_mcp_server_call"), 3000, "native tool result projection");
    assert.ok(events.find(event => event.type === "tool.result"
      && event.payload.tool?.name === "shoggoth_mcp_server_call").payload.tool.pluginAppCallId,
    "App receipt must survive the actual native tool event and Coordinator UI projection");
    const history = await new ShoggothBackend({ paths })._call("chat.history", {
      sessionKey: session.sessionKey, cursor: null, limit: 100 });
    assert(JSON.stringify(history).includes("pluginAppCallId"), "persisted transcript history retains structured App reference");
    const write = call(first.host, "mcp_server_call", { serverId, toolName: "write_note",
      arguments: { text: "actual local stdio", expectedRevision: 0 } });
    await waitUntil(() => service.workRunCoordinator.getRun(first.run.id).status === "waiting_approval", 3000, "each-call");
    const waiting = service.workRunCoordinator.getRun(first.run.id);
    await service.workRunCoordinator.respondApproval({ operationId: "chain-consent", runId: first.run.id,
      requestId: waiting.waitingRequestId, choice: "once" });
    assert.equal((await write).result?.isError, false);
    const after = await call(first.host, "mcp_server_call", { serverId, toolName: "read_note", arguments: {} });
    assert(JSON.stringify(after).includes("actual local stdio"));
    await service.workRunCoordinator.abort({ operationId: "chain-abort-1", runId: first.run.id, sessionKey: session.sessionKey });
    assert.equal((await call(first.host, "app_status")).result?.isError, true);
    const second = await begin("chain-run-2");
    assert.notEqual(second.host.child.pid, first.host.child.pid, "next Run owns a new actual runtime process");
    assert.equal((await call(second.host, "app_status")).result?.isError, false);
    assert.equal((await call(first.host, "app_status")).result?.isError, true, "old bridge cannot revive for next Run");
    await service.workRunCoordinator.abort({ operationId: "chain-abort-2", runId: second.run.id, sessionKey: session.sessionKey });
    console.log("PASS OpenCode real Pool/Host + local CLI process + GateIssuer + bootstrap + relay + Service + local-notes stdio: native tool, plugin list/read/write, each-call, App receipt, next-Run process isolation, old bridge revocation");
  } finally {
    await service.stop({ notify: false });
    for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
