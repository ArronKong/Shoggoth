"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { ENDPOINT } = require("../app/agent-service/plugin-cloudflare-bearer-verifier");

const TOKEN = "cfut_fixture_private_token";
const PRINCIPAL = "cloudflare-token:100bf38cc8393103870917dd535e0628"; // gitleaks:allow -- deterministic fixture principal derived from a fake token

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgcfbear-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const encryptionKey = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    },
  };
  const verified = [];
  const service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false,
    parentEnv: {}, version: "cloudflare-bearer-fixture",
    pluginCloudflareBearerVerifier: async token => {
      verified.push(token);
      if (token !== TOKEN) throw new Error("invalid fixture token");
      return PRINCIPAL;
    } });
  let web;
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    backend._profilesByAgent.set(profile.agentId, profile);
    const preview = await backend.previewPluginInstall({ kind: "bundled", packageId: "cloudflare" });
    assert.equal(preview.components.mcpServers[0].name, "cloudflare-api");
    const installed = await backend.installPlugin({ source: { kind: "bundled", packageId: "cloudflare" },
      previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision,
      operationId: "cloudflare-install" });
    const enabled = await backend.setPluginInstallationState({
      installationId: installed.installation.installationId, desiredState: "enabled",
      expectedRevision: installed.installation.revision, operationId: "cloudflare-enable" });
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const component = page.items.find(item => item.installationId === enabled.installation.installationId)
      .components.find(item => item.localName === "cloudflare-api");
    assert.equal(component.transport, "streamable-http");
    let approve = false;
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => id === profile.agentId ? backend : null,
        backends: new Map([["shoggoth", backend]]) },
      hostOps: { async confirmPluginCapability(summary) {
        assert.equal(summary.action, "bearer-connect");
        assert.equal(summary.provider, "Cloudflare");
        assert.equal(JSON.stringify(summary).includes(TOKEN), false);
        return approve;
      } } });
    const input = { agentId: profile.agentId, installationId: enabled.installation.installationId,
      componentId: component.componentId, expectedRevision: enabled.installation.revision,
      operationId: "cloudflare-connect", accessToken: TOKEN };
    const post = async (value, origin = web.url) => {
      const response = await fetch(`${web.url}/__api/plugins/bearer-connect`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
      const raw = await response.text();
      let body; try { body = JSON.parse(raw); } catch { body = { error: raw }; }
      assert.equal(JSON.stringify(body).includes(TOKEN), false);
      return { status: response.status, body };
    };
    assert.equal((await post(input, "https://evil.example")).status, 403);
    assert.deepEqual(await post(input), { status: 200, body: { canceled: true, receipt: null } });
    assert.deepEqual(verified, []);
    approve = true;
    const connected = await post(input);
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.deepEqual(verified, [TOKEN]);
    const binding = service.pluginStore.getBinding(connected.body.receipt.bindingId);
    assert.equal(binding.enabled, true);
    const connection = service.pluginStore.getConnection(binding.connectionId);
    assert.equal(connection.endpointIdentity, ENDPOINT);
    assert.equal(connection.principalIdentity, PRINCIPAL);
    assert.equal((await service.pluginCredentialVault.readCredential(binding.connectionId)).accessToken, TOKEN);
    assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes(TOKEN), false);
    const status = await backend.getPluginMcpStatus(profile.agentId, input.installationId);
    assert.match(status.items.find(item => item.componentId === input.componentId)
      .accounts[0].label, /^Cloudflare Token /u);
    console.log("Cloudflare fixed-endpoint bearer install / Service / UI route / encrypted account fixture: PASS");
  } finally {
    if (web) await web.close();
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
