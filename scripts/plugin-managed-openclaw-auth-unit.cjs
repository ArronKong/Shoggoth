#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createManagedOpenClawProductAuth } = require("../app/managed-openclaw-product-auth");
async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-managed-host-auth-")); fs.chmodSync(root, 0o700);
  let mode = false, endpoint = null, legacyReads = 0, generation = 0;
  const credentialsDir = path.join(root, "credentials"), dataRoot = path.join(root, "data");
  const host = { isManaged: () => mode, getEndpoint: () => endpoint };
  const legacyResolver = { getGatewayUrl: () => "ws://127.0.0.1:old",
    resolveConnectAuth: () => { legacyReads += 1; return { token: "legacy-only" }; },
    resolveConnectAuthAsync: async () => { legacyReads += 1; return { token: "legacy-only" }; },
    storeDeviceToken: () => { legacyReads += 1; }, clearDeviceToken: () => { legacyReads += 1; } };
  const resolver = createManagedOpenClawProductAuth({ host, legacyResolver, credentialsDir, dataRoot, getGatewayGeneration: () => generation });
  try {
    assert.equal(resolver.resolveConnectAuth().token, "legacy-only");
    assert.equal(fs.existsSync(credentialsDir), false);
    mode = true;
    assert.equal(resolver.getGatewayUrl(), "");
    assert.throws(() => resolver.resolveConnectAuth(), { code: "MANAGED_HOST_ENDPOINT_UNVERIFIED" });
    await assert.rejects(resolver.resolveConnectAuthAsync(), { code: "MANAGED_HOST_ENDPOINT_UNVERIFIED" });
    assert.equal(legacyReads, 1); assert.equal(fs.existsSync(credentialsDir), false);
    console.log("PASS unavailable managed endpoint never reads legacy credentials or creates a fallback identity");
    endpoint = { url: "ws://127.0.0.1:54321", token: "fixture-shared-gateway-token" };
    const auth = await resolver.resolveConnectAuthAsync(endpoint.url);
    assert.equal(auth.token, endpoint.token); assert.equal(auth.deviceToken, undefined);
    assert.equal(auth.deviceId, resolver.resolveConnectAuth(endpoint.url).deviceId);
    assert.equal(legacyReads, 1);
    assert.equal(fs.statSync(credentialsDir).mode & 0o077, 0);
    assert.equal(resolver.getGatewayUrl(), endpoint.url);
    assert.equal(resolver.getGatewayGeneration(), 0); generation += 1;
    assert.equal(resolver.getGatewayGeneration(), 1);
    console.log("PASS Backend and chat share one actual private Ed25519 identity and verified Gateway token");
    assert.throws(() => resolver.resolveConnectAuth("ws://127.0.0.1:54322"), { code: "MANAGED_HOST_ENDPOINT_UNVERIFIED" });
    endpoint = null;
    assert.throws(() => resolver.storeDeviceToken("never-store", 1, "ws://127.0.0.1:54321"), { code: "MANAGED_HOST_ENDPOINT_UNVERIFIED" });
    assert.equal(legacyReads, 1);
    console.log("PASS stale/replaced endpoint cannot reuse or store old Gateway credentials");
    endpoint = { url: "ws://127.0.0.1:54321", token: "fixture-shared-gateway-token" };
    const file = path.join(credentialsDir, "device-credentials.json");
    fs.chmodSync(file, 0o644);
    assert.throws(() => resolver.resolveConnectAuth(), { code: "MANAGED_HOST_PRIVATE_FILE_UNSAFE" });
    fs.chmodSync(file, 0o600); fs.chmodSync(credentialsDir, 0o755);
    await assert.rejects(resolver.resolveConnectAuthAsync(), { code: "MANAGED_HOST_PRIVATE_PATH_UNSAFE" });
    fs.chmodSync(credentialsDir, 0o700);
    const saved = path.join(root, "identity-original.json"); fs.renameSync(file, saved);
    fs.symlinkSync(saved, file);
    assert.throws(() => resolver.resolveConnectAuth(), { code: "MANAGED_HOST_PRIVATE_FILE_UNSAFE" });
    fs.unlinkSync(file); fs.linkSync(saved, file);
    assert.throws(() => resolver.resolveConnectAuth(), { code: "MANAGED_HOST_PRIVATE_FILE_UNSAFE" });
    fs.unlinkSync(file); fs.renameSync(saved, file);
    assert.equal(resolver.resolveConnectAuth().token, endpoint.token);
    assert.equal(legacyReads, 1);
    console.log("PASS unsafe existing file/directory, symlink and hardlink identity fail closed before key reuse");
    console.log(JSON.stringify({ ok: true, groups: 4, remoteCalls: 0, modelCalls: 0, legacyReadsWhileManaged: 0 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
