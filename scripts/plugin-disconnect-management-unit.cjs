"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgdc-")), key = crypto.randomBytes(32);
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, c.update(value, "utf8"), c.final(), c.getAuthTag()]); },
    decryptString(value) { const c = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      c.setAuthTag(value.subarray(-16)); return Buffer.concat([c.update(value.subarray(12, -16)), c.final()]).toString("utf8"); } };
  const options = { paths, safeStorage, parentEnv: {}, prewarmMcpAuth: false };
  let service = createAgentService(options), web, held;
  let approved = true, confirmations = 0;
  const summaries = [];
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths }), profile = service.productStore.listAgentProfiles().find(value => value.enabled);
    backend._profilesByAgent.set(profile.agentId, profile);
    const source = path.join(root, "package"); fs.mkdirSync(source, { mode: 0o700 });
    fs.writeFileSync(path.join(source, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "disconnect-fixture" }));
    fs.writeFileSync(path.join(source, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["./server.cjs"] } } }));
    fs.writeFileSync(path.join(source, "server.cjs"), `require('node:fs').writeFileSync(require('node:path').join(process.env.PLUGIN_DATA,'pid'),String(process.pid));\n${fs.readFileSync(path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"), "utf8")}`);
    const sourceInput = { kind: "directory", path: source }, preview = await backend.previewPluginInstall(sourceInput);
    const installed = await backend.installPlugin({ source: sourceInput, previewDigest: preview.previewDigest, expectedRevision: 0, operationId: "install-disconnect" });
    const installationId = installed.installation.installationId;
    const component = (await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null })).items[0].components[0];
    const pin = { installationId, componentId: component.componentId, releaseDigest: installed.installation.releaseDigest, descriptorDigest: component.descriptorDigest };
    // Native interpreter preparation is independently covered by its fixture.
    const dependencies = service.pluginDependencyController.registry;
    const prepared = dependencies.preview({ ...pin, executablePath: process.execPath });
    dependencies.prepare({ ...pin, executablePath: process.execPath, previewDigest: prepared.previewDigest,
      expectedRevision: 0, operationId: "prepare-node", confirmed: true });
    const enabled = service.pluginStore.setInstallationDesiredState({ installationId, desiredState: "enabled", expectedRevision: installed.installation.revision });
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => id === profile.agentId ? backend : null, backends: new Map([["shoggoth", backend]]) },
      hostOps: { async confirmPluginCapability(summary) { confirmations += 1; summaries.push(summary); return approved; } } });
    const post = async (route, body, origin = web.url) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
      const bodyText = await response.text();
      let value; try { value = JSON.parse(bodyText); } catch { value = { error: bodyText }; }
      for (const secret of [root, "principalIdentity", "credentialRef", "authorityIncarnation", "challenge", "endpointIdentity"]) {
        assert.equal(JSON.stringify(value).includes(secret), false, `public DTO excludes ${secret}`);
      }
      return { status: response.status, body: value };
    };
    const connected = await post("mcp-consent", { action: "connect", agentId: profile.agentId,
      installationId, componentId: pin.componentId, expectedRevision: enabled.revision, operationId: "connect-stdio" });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const bindingId = connected.body.receipt.bindingId;
    assert.equal((await post("mcp-discover", { agentId: profile.agentId, bindingId })).status, 200);
    const binding = service.pluginStore.getBinding(bindingId), connection = service.pluginStore.getConnection(binding.connectionId);
    held = await service.pluginMcpConnectionManager.acquire({ installation: enabled, binding, connection });
    const scopeId = crypto.createHash("sha256").update(JSON.stringify([pin.componentId, connection.connectionId, connection.principalIdentity])).digest("hex");
    const pid = Number(fs.readFileSync(path.join(paths.pluginDataDir, installationId, scopeId, "pid"), "utf8"));
    process.kill(pid, 0);
    const toolIdentity = `plugin:${installationId}:${pin.componentId}:${connection.connectionId}:${"a".repeat(64)}`;
    service.pluginStore.setGrant({ grantId: "disconnect-grant", bindingId, toolIdentity, contractDigest: "b".repeat(64), effect: "allow", approvalMode: "always", expectedRevision: 0 });
    const request = { agentId: profile.agentId, bindingId, expectedRevision: binding.revision, operationId: "disconnect-account" };
    const originalConfirmations = confirmations;
    assert.equal((await post("disconnect", request, "https://evil.invalid")).status, 403);
    for (const extra of [{ approved: true }, { connectionId: "other" }, { credentialRef: "secret" }, { deleteCredentials: true }]) {
      assert.equal((await post("disconnect", { ...request, ...extra })).status, 400);
    }
    assert.equal(confirmations, originalConfirmations);
    approved = false;
    assert.deepEqual(await post("disconnect", request), { status: 200, body: { canceled: true, receipt: null } });
    assert.equal(service.pluginStore.getConnection(connection.connectionId).state, "ready"); process.kill(pid, 0);
    approved = true;
    const result = await post("disconnect", request);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.receipt.cleanupStatus, "complete"); assert.equal(result.body.receipt.credentialDisposition, "none");
    assert.equal(summaries.at(-1).action, "mcp-disconnect"); assert.equal(summaries.at(-1).affectedBindings, 1);
    assert.equal(service.pluginStore.getConnection(connection.connectionId).authRevision, connection.authRevision + 1);
    assert.equal(service.pluginStore.getGrant(bindingId, toolIdentity).effect, "deny");
    assert.equal(service.pluginStore.getBinding(bindingId).enabled, false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(held.listTools(), { code: "PLUGIN_CONNECTION_CLOSED" });
    await held.release(); held = null;
    const operation = await post("disconnect-operation", { agentId: profile.agentId, operationId: request.operationId });
    assert.equal(operation.status, 200); assert.equal(operation.body.phase, "completed");
    assert.equal((await post("disconnect", request)).body.receipt.cleanupStatus, "complete");
    assert.equal(service.pluginStore.getConnection(connection.connectionId).authRevision, connection.authRevision + 1);
    await service.stop({ notify: false }); service = createAgentService(options); await service.start();
    const restored = await post("disconnect-operation", { agentId: profile.agentId, operationId: request.operationId });
    assert.equal(restored.body.phase, "completed"); assert.equal(restored.body.receipt.cleanupStatus, "pending");
    assert.equal((await post("disconnect", request)).body.receipt.cleanupStatus, "complete");
    assert.equal(service.pluginStore.getConnection(connection.connectionId).authRevision, connection.authRevision + 1);
    await service.stop({ notify: false });
    const isolated = new PluginStore({ paths }).open();
    try { isolated.rotateAuthorityForRestore({ backupId: "disconnect-fixture-restore" }); } finally { isolated.close(); }
    service = createAgentService(options); await service.start();
    const unknown = await post("disconnect-operation", { agentId: profile.agentId, operationId: request.operationId });
    assert.equal(unknown.body.phase, "outcome_unknown"); assert.equal(unknown.body.receipt, null);
    assert.equal((await post("disconnect", request)).status, 409);
    console.log("plugin disconnect Service/Backend/REST/native consent/real held stdio process exit/recovery fixture: PASS");
  } finally {
    await held?.release(); await web?.close(); await service.stop({ notify: false }); key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
