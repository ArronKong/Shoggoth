#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgdm-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const encryptionKey = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    } };
  const options = { paths, safeStorage, prewarmMcpAuth: false, parentEnv: {}, version: "dependency-management-fixture" };
  let service = createAgentService(options), web;
  let selected = null, approved = false, confirmations = 0, selections = 0, probes = 0;
  const summaries = [];
  const assertPublic = value => {
    const json = JSON.stringify(value);
    for (const hidden of [root, process.execPath, fs.realpathSync(process.execPath), "selectedPath", "canonicalPath",
      "executablePath", "sha256", "previewDigest", "challenge", "authorityIncarnation", "principalIdentity", "credentialRef"]) {
      assert.equal(json.includes(hidden), false, `browser DTO must exclude ${hidden}`);
    }
  };
  const watchProbes = () => {
    const registry = service.pluginDependencyController.registry;
    const probe = registry.runProbe;
    registry.runProbe = (...args) => { probes += 1; return probe(...args); };
  };
  try {
    await service.start(); watchProbes();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    backend._profilesByAgent.set(profile.agentId, profile);
    const source = path.join(root, "package"); fs.mkdirSync(source, { mode: 0o700 });
    fs.writeFileSync(path.join(source, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "dependency-management-fixture" }));
    fs.writeFileSync(path.join(source, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["./server.cjs"] } } }));
    const fixtureScript = fs.readFileSync(path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"), "utf8");
    fs.writeFileSync(path.join(source, "server.cjs"), `require('node:fs').writeFileSync(
      require('node:path').join(process.env.PLUGIN_DATA,'startup.json'),JSON.stringify({pid:process.pid,
      nodeOptions:process.env.NODE_OPTIONS||null,path:process.env.PATH}));\n${fixtureScript}`);
    const sourceInput = { kind: "directory", path: source };
    const preview = await backend.previewPluginInstall(sourceInput);
    const installed = await backend.installPlugin({ source: sourceInput, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "dependency-install" });
    const installationId = installed.installation.installationId;
    let installationRevision = installed.installation.revision;
    const catalog = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const component = catalog.items[0].components.find(item => item.localName === "local");
    const selector = { installationId, componentId: component.componentId };
    const native = { async selectPluginDependency() { selections += 1; return selected; },
      async confirmPluginCapability(summary) {
        confirmations += 1; summaries.push(summary);
        if (summary.action.startsWith("dependency-")) {
          assert.equal(summary.package, "dependency-management-fixture");
          assert.equal(summary.capability, "local"); assert.equal(summary.interpreter, "node");
          assert.equal(summary.executablePath, fs.realpathSync(process.execPath));
          assert.match(summary.sha256, /^[a-f0-9]{64}$/u);
        }
        return approved;
      } };
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => id === profile.agentId ? backend : null, backends: new Map([["shoggoth", backend]]) },
      hostOps: native });
    const post = async (route, body, origin = web.url) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await response.text();
      let value; try { value = JSON.parse(text); } catch { value = { error: text }; }
      assertPublic(value); return { status: response.status, body: value };
    };
    const change = operationId => ({ ...selector, action: "prepare", expectedRevision: installationRevision, operationId });
    const state = async desiredState => {
      const result = await post("state", { installationId, desiredState,
        expectedRevision: installationRevision, operationId: `state-${desiredState}-${installationRevision}` });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      installationRevision = result.body.installation.revision;
      return result;
    };
    const initial = await post("dependency-status", selector);
    assert.equal(initial.status, 200); assert.equal(initial.body.status, "missing");
    assert.equal(initial.body.revision, 0); assert.equal(initial.body.version, null);
    assert.equal((await post("dependency-change", change("bad-origin"), "https://evil.example")).status, 403);
    for (const extra of [{ executablePath: process.execPath }, { confirmed: true }, { approved: true }, { previewDigest: "a".repeat(64) }]) {
      assert.equal((await post("dependency-change", { ...change("extra-field"), ...extra })).status, 400);
    }
    assert.equal(selections, 0); assert.equal(confirmations, 0); assert.equal(probes, 0);
    const canceledSelection = await post("dependency-change", change("cancel-picker"));
    assert.deepEqual(canceledSelection, { status: 200, body: { canceled: true, receipt: null } });
    assert.equal(confirmations, 0); assert.equal(probes, 0);
    selected = process.execPath;
    const canceledConsent = await post("dependency-change", change("cancel-confirm"));
    assert.deepEqual(canceledConsent, { status: 200, body: { canceled: true, receipt: null } });
    assert.equal(confirmations, 1); assert.equal(probes, 0);
    assert.equal(fs.existsSync(service.pluginDependencyController.registry.file), false,
      "picker and consent cancellation must not create a dependency authority file");
    approved = true;
    await state("enabled");
    assert.equal((await post("dependency-change", change("enabled-denied"))).status, 409);
    assert.equal(confirmations, 1); assert.equal(probes, 0);
    await state("disabled");

    // Lose the operation response after the durable commit, then recover by ID
    // without accepting a second confirmation or running a second probe.
    service.pluginDependencyController.registry.onPhase = phase => {
      if (phase === "dependency-committed") throw Object.assign(new Error("fixture response lost"), { code: "PLUGIN_SIMULATED_CRASH" });
    };
    const ambiguous = await post("dependency-change", change("response-lost"));
    assert.notEqual(ambiguous.status, 200); assert.equal(probes, 1);
    service.pluginDependencyController.registry.onPhase = null;
    const receipt = await post("dependency-operation", { operationId: "response-lost" });
    assert.equal(receipt.status, 200); assert.equal(receipt.body.found, true);
    assert.equal(receipt.body.phase, "completed"); assert.equal(receipt.body.receipt.status, "ready");
    assert.equal(receipt.body.receipt.version, process.version); assert.equal(receipt.body.receipt.revision, 1);
    assert.equal((await post("dependency-status", selector)).body.status, "ready");
    const noOperation = await post("dependency-operation", { operationId: "not-created" });
    assert.equal(noOperation.body.found, false); assert.equal(noOperation.body.receipt, null);
    assert.equal((await post("dependency-operation", { operationId: "response-lost", executablePath: selected })).status, 400);
    const confirmationCount = confirmations, selectionCount = selections;
    await service.stop({ notify: false });
    service = createAgentService(options); await service.start(); watchProbes();
    const recovered = await post("dependency-operation", { operationId: "response-lost" });
    assert.deepEqual(recovered, receipt);
    assert.equal(probes, 1); assert.equal(confirmations, confirmationCount); assert.equal(selections, selectionCount);

    await state("enabled");
    const connect = await post("mcp-consent", { action: "connect", agentId: profile.agentId,
      ...selector, expectedRevision: installationRevision, operationId: "connect-prepared-node" });
    assert.equal(connect.status, 200, JSON.stringify(connect.body));
    const bindingId = connect.body.receipt.bindingId;
    const discovery = await post("mcp-discover", { agentId: profile.agentId, bindingId });
    assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
    const tools = await backend.getPluginMcpTools(profile.agentId, bindingId);
    assertPublic(tools); assert.ok(JSON.stringify(tools).includes("echo"));
    const binding = service.pluginStore.getBinding(bindingId);
    const connection = service.pluginStore.getConnection(binding.connectionId);
    const scopeId = crypto.createHash("sha256").update(JSON.stringify([
      component.componentId, connection.connectionId, connection.principalIdentity,
    ])).digest("hex");
    const startupPath = path.join(paths.pluginDataDir, installationId, scopeId, "startup.json");
    const startup = JSON.parse(fs.readFileSync(startupPath));
    assert.equal(startup.nodeOptions, null); assert.equal(startup.path, "");
    process.kill(startup.pid, 0);
    await state("disabled");
    assert.throws(() => process.kill(startup.pid, 0), { code: "ESRCH" });
    const revoked = await post("dependency-change", { ...change("dependency-revoke"), action: "revoke" });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.receipt.status, "revoked"); assert.equal(revoked.body.receipt.revision, 2);
    assert.equal((await post("dependency-status", selector)).body.status, "revoked");
    assert.equal(probes, 1, "revocation never probes or starts code");

    // Simulate the authority-rotation step used only on an isolated restore.
    await service.stop({ notify: false });
    const isolatedStore = new PluginStore({ paths }).open();
    try { isolatedStore.rotateAuthorityForRestore({ backupId: "dependency-fixture-restore" }); }
    finally { isolatedStore.close(); }
    service = createAgentService(options); await service.start(); watchProbes();
    const old = await post("dependency-operation", { operationId: "response-lost" });
    assert.equal(old.status, 200); assert.equal(old.body.phase, "outcome_unknown");
    assert.equal(old.body.receipt, null); assert.equal(old.body.reasonCode, "PLUGIN_RESTORE_RECONCILIATION_REQUIRED");
    assert.equal((await post("dependency-status", selector)).body.status, "stale");
    assert.equal(probes, 1);
    console.log("plugin dependency Service / Backend / REST / native selection / real stdio / recovery fixture: PASS");
  } finally {
    await web?.close(); await service.stop({ notify: false });
    encryptionKey.fill(0); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
