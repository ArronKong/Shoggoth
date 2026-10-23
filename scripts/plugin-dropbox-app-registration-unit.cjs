"use strict";

// An isolated loopback App request crosses REST, Backend, authenticated Service
// RPC, native confirmation, and the encrypted Dropbox registration store.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { loadDropboxRegistration } = require("../app/agent-service/plugin-dropbox-registration");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-dropbox-app-")));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    } };
  const options = { paths, safeStorage, prewarmMcpAuth: false, parentEnv: {},
    version: "plugin-dropbox-app-registration-fixture" };
  const secret = crypto.randomBytes(24).toString("hex");
  const input = { clientId: "ownDropboxAppKey123", clientSecret: secret,
    redirectPort: 39742 };
  let service = createAgentService(options);
  let web, approve = false, confirmations = 0;
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const registry = { backends: new Map([["shoggoth", backend]]) };
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry, hostOps: { async confirmPluginCapability(summary) {
        confirmations += 1;
        assert.deepEqual(summary, { action: "dropbox-registration", provider: "Dropbox",
          clientId: input.clientId,
          redirectUrl: "http://127.0.0.1:39742/oauth/callback", scopes: ["files.metadata.read", "files.content.read", "files.content.write", "sharing.write", "account_info.read", "sharing.read", "file_requests.read", "file_requests.write"] });
        assert.equal(JSON.stringify(summary).includes(secret), false);
        return approve;
      } } });
    const post = async (route, body, extraHeaders = {}) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin: web.url, "content-type": "application/json", ...extraHeaders },
        body: JSON.stringify(body) });
      const text = await response.text();
      assert.equal(text.includes(secret), false, "REST response cannot echo client secret");
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: response.status, body: parsed };
    };
    const status = () => post("dropbox-registration-status", {});
    const configure = (body = input, headers = {}) => post("dropbox-registration-configure", body, headers);
    assert.deepEqual(await status(), { status: 200,
      body: { configured: false, restartRequired: false } });
    const noNative = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry });
    try {
      const response = await fetch(`${noNative.url}/__api/plugins/dropbox-registration-configure`, {
        method: "POST", headers: { origin: noNative.url, "content-type": "application/json" },
        body: JSON.stringify(input) });
      assert.equal(response.status, 501, "missing native confirmation must fail closed");
      assert.equal((await response.text()).includes(secret), false);
    } finally { await noNative.close(); }
    await assert.rejects(requestService(paths, { token: "wrong", version: SERVICE_PROTOCOL_VERSION,
      method: "plugins.dropbox.registration.status", params: {} }), { code: "AUTH_FAILED" });
    assert.equal((await configure(input, { origin: "https://evil.example" })).status, 403);
    assert.equal((await configure(input, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await configure({ ...input, provider: "foreign" })).status, 400);
    assert.equal(confirmations, 0);
    assert.deepEqual(await configure(), { status: 200,
      body: { configured: false, restartRequired: false } });
    assert.deepEqual(await status(), { status: 200,
      body: { configured: false, restartRequired: false } });
    assert.equal(loadDropboxRegistration(paths), null);
    approve = true;
    assert.deepEqual(await configure(), { status: 200,
      body: { configured: true, restartRequired: true } });
    assert.deepEqual(await status(), { status: 200,
      body: { configured: true, restartRequired: true } });
    assert.equal(confirmations, 2);
    assert.equal(loadDropboxRegistration(paths).clientId, input.clientId);
    assert.equal(fs.readFileSync(path.join(paths.pluginsDir,
      "dropbox-client-registration.json"), "utf8").includes(secret), false);
    assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes(secret), false);
    assert.equal((await configure()).status, 409, "configured clients have no overwrite path");
    assert.equal(confirmations, 2, "an overwrite cannot reach native confirmation");
    await service.stop({ notify: false });
    service = createAgentService(options);
    await service.start();
    assert.deepEqual(await status(), { status: 200,
      body: { configured: true, restartRequired: false } });
    await service.stop({ notify: false });
    service = null;
    assert.notEqual((await status()).status, 200, "missing Service must not claim configuration");
    console.log("Dropbox App REST / Backend / authenticated Service / native confirmation fixture: PASS");
  } finally {
    await web?.close();
    if (service) await service.stop({ notify: false });
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
