"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { startStaticServer } = require("../app/static-server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
async function main() {
  const root = fs.mkdtempSync("/private/tmp/sg-web-api-");
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "data"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32), broker = {
    async open() {}, async close() {},
    async encrypt(bytes) { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce); return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); },
    async decrypt(bytes) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0,12)); decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12,-16)), decipher.final()]); },
  };
  const service = createAgentService({ paths, cryptoBroker: broker, parentEnv: {}, prewarmMcpAuth: false, autoSparkNotes: false });
  const rpc = (method, params, token = readClientToken(paths)) => requestService(paths, { token, version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 20000 });
  let http;
  try {
    await service.start();
    await assert.rejects(rpc("web.settings.get", {}, "untrusted"), { code: "AUTH_FAILED" });
    await assert.rejects(rpc("web.settings.get", { extra: true }), { code: "WEB_SETTINGS_INVALID" });
    assert.equal((await rpc("web.settings.get", {})).revision, 0);
    // Exercise the real Backend method rather than replacing the DTO boundary.
    const backend = Object.create(ShoggothBackend.prototype);
    Object.assign(backend, { paths, readToken: readClientToken, requestService, randomUUID: crypto.randomUUID });
    http = await startStaticServer(0, { homeDir: path.join(root, "home"), registry: { webSettingsCall: (...args) => backend.webSettingsCall(...args) } });
    const request = (route, method = "GET", body, origin = http.url) => fetch(http.url + "/__api/web-settings" + route, {
      method, headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await request("", "PUT", {}, "https://untrusted.example")).status, 403);
    assert.equal((await request("", "PUT", {}, null)).status, 403);
    assert.equal((await request("/credentials", "GET")).status, 405);
    const config = { searchProvider: "tinyfish", fetchProvider: "tavily" };
    const saved = await request("", "PUT", { expectedRevision: 0, config }); assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).config, config);
    assert.equal((await request("", "PUT", { expectedRevision: 0, config })).status, 409);
    const secret = "fixture-private-tinyfish-service-key";
    const keySaved = await request("/credentials", "PUT", { provider: "tinyfish", apiKey: secret, expectedRevision: null });
    assert.equal(keySaved.status, 200); const snapshot = await keySaved.json(); assert.equal(snapshot.credentials.tinyfish.configured, true);
    for (const value of [snapshot, await (await request("")).json()]) {
      assert(!JSON.stringify(value).includes(secret)); assert(!JSON.stringify(value).includes("credentialRef"));
    }
    assert(!fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes(secret));
    await service.stop({ notify: false }); await service.start();
    const after = await rpc("web.settings.get", {}); assert.deepEqual(after.config, config); assert.equal(after.credentials.tinyfish.configured, true);
    const clear = await request("/credentials", "DELETE", { provider: "tinyfish", expectedRevision: after.credentials.tinyfish.revision });
    assert.equal(clear.status, 200); assert.equal((await clear.json()).credentials.tinyfish.configured, false);
    console.log("PASS web settings real Service + Backend + HTTP: token/origin/method/schema, CAS, encrypted key, restart and deletion; no real Provider/model calls");
  } finally { if (http) await http.close(); await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
