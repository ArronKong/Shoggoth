"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertSafeSmokeRequest, guardHermesReadOnlyLifecycle, attachExistingHermesReadOnly, withMediaFixture, openClawReadOnlyOptions } = require("./crud-smoke-safety.cjs");
const { generateIdentity } = require("../app/core/device-auth");

async function main() {
  const base = "http://127.0.0.1:1";
  for (const route of [
    "/__api/cron/jobs/id/run", "/__api/cron/jobs", "/__api/tasks?action=move",
    "/__api/tasks/home-channels?platform=telegram", "/__api/tasks/boards/default/switch",
    "/__api/tasks/orchestration", "/__api/skills?name=existing", "/__api/agents/existing",
    "/__api/sessions/fork", "/__api/oauth/cancel", "/__api/updates/run?backend=hermes",
  ]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.throws(() => assertSafeSmokeRequest(method, base + route, {}), { code: "SMOKE_LIVE_WRITE_FORBIDDEN" });
    }
    assert.doesNotThrow(() => assertSafeSmokeRequest("GET", base + route));
  }
  console.log("ok - real execution, subscription, board selection and config writes rejected before transport");

  assert.throws(() => assertSafeSmokeRequest("PUT", base + "/__api/models/config/model", {}), { code: "SMOKE_LIVE_WRITE_FORBIDDEN" });
  assert.doesNotThrow(() => assertSafeSmokeRequest("PUT", base + "/__api/models/config/model", {}, { modelFixture: true }));
  assert.doesNotThrow(() => assertSafeSmokeRequest("PUT", base + "/__api/config", {}));
  assert.doesNotThrow(() => assertSafeSmokeRequest("POST", base + "/__api/updates/run?backend=nope", {}));
  console.log("ok - scratch config and explicitly installed model fixture remain usable");

  let processChanges = 0;
  const backend = {
    _spawnDashboard: async () => { processChanges++; },
    _reapStaleDashboard: async () => { processChanges++; },
  };
  const assertReadOnly = guardHermesReadOnlyLifecycle(backend);
  assertReadOnly();
  await assert.rejects(backend.start(), { code: "SMOKE_LIVE_START_UNSAFE" });
  await assert.rejects(backend._spawnDashboard("default"), { code: "SMOKE_LIVE_START_UNSAFE" });
  await assert.rejects(backend._reapStaleDashboard(9000), { code: "SMOKE_LIVE_START_UNSAFE" });
  assert.throws(assertReadOnly, { code: "SMOKE_LIVE_START_UNSAFE" });
  assert.equal(processChanges, 0);
  console.log("ok - dashboard spawn/reap remain blocked even if Backend catches the error");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-crud-safety-"));
  try {
    const appData = path.join(root, "app");
    const scratch = path.join(root, "scratch");
    const credentialsDir = path.join(appData, "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.mkdirSync(scratch);
    const configPath = path.join(appData, "config.json");
    const credentialFile = path.join(credentialsDir, "device-credentials.json");
    fs.writeFileSync(configPath, JSON.stringify({ gatewayUrl: "ws://127.0.0.1:9876", token: "fixture-shared-token" }));
    fs.writeFileSync(credentialFile, JSON.stringify({ version: 1, identity: generateIdentity(), deviceTokens: {} }));
    const originalCredentials = fs.readFileSync(credentialFile, "utf8");
    const originalConfig = fs.readFileSync(configPath, "utf8");
    const options = openClawReadOnlyOptions({ configPath, credentialsDir, scratchDirectory: scratch,
      operatorIdentityDir: path.join(root, "missing-operator"), localGatewayConfigPath: path.join(root, "missing-gateway") });
    assert.equal(options.getUpstreamUrl(), "ws://127.0.0.1:9876");
    assert.equal(options.getOrigin(), "http://127.0.0.1:18799");
    assert.equal(options.authResolver.resolveConnectAuth().deviceId, JSON.parse(originalCredentials).identity.deviceId);
    assert.equal((await options.authResolver.resolveConnectAuthAsync()).deviceId, JSON.parse(originalCredentials).identity.deviceId);
    options.authResolver.storeDeviceToken("rotated-fixture-token", 1);
    options.authResolver.clearDeviceToken();
    assert.equal(fs.readFileSync(credentialFile, "utf8"), originalCredentials);
    assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig);
    console.log("ok - Gateway endpoint and identity match existing App with auth writes isolated to scratch");

    const emptyScratch = path.join(root, "empty-scratch");
    fs.mkdirSync(emptyScratch);
    const missingIdentity = openClawReadOnlyOptions({ configPath, credentialsDir: path.join(root, "missing"), scratchDirectory: emptyScratch,
      operatorIdentityDir: path.join(root, "missing-operator"), localGatewayConfigPath: path.join(root, "missing-gateway") });
    assert.throws(() => missingIdentity.authResolver.resolveConnectAuth(), { code: "SMOKE_LIVE_IDENTITY_UNAVAILABLE" });
    await assert.rejects(missingIdentity.authResolver.resolveConnectAuthAsync(), { code: "SMOKE_LIVE_IDENTITY_UNAVAILABLE" });
    fs.writeFileSync(configPath, JSON.stringify({ gatewayUrl: "wss://example.com" }));
    assert.throws(() => openClawReadOnlyOptions({ configPath, credentialsDir, scratchDirectory: scratch }), { code: "SMOKE_LIVE_GATEWAY_UNSUPPORTED" });
    console.log("ok - no new device connects and local credentials cannot be sent to a remote endpoint");

    const reads = [];
    const attached = {
      startPort: 9100, dashboards: new Map(), profileById: new Map(),
      _refreshAgentsFor: async () => { attached.profileById.set("hermes-default", "default"); },
      refreshSessions: async () => { reads.push("sessions"); },
      refreshModelChoices: async () => { reads.push("models"); },
    };
    const assertNoLifecycle = guardHermesReadOnlyLifecycle(attached);
    await attachExistingHermesReadOnly(attached, { home: root, portCount: 2, get: async (url) => {
      reads.push(url);
      return { status: 200, body: url.endsWith("/api/status")
        ? JSON.stringify({ hermes_home: root }) : '__HERMES_SESSION_TOKEN__="fixture-token"' };
    } });
    assertNoLifecycle();
    assert.deepEqual(reads, ["http://127.0.0.1:9100/", "http://127.0.0.1:9100/api/status", "sessions", "models"]);
    assert.equal(attached.dashboards.get("default").spawned, false);
    assert.equal(attached.dashboards.get("default").proc, null);
    console.log("ok - attachment uses identity-verified GETs without any Backend lifecycle call");

    attached.dashboards.clear();
    await assert.rejects(attachExistingHermesReadOnly(attached, {
      home: root, portCount: 1, get: async () => ({ status: 503, body: "unavailable" }),
    }), { code: "SMOKE_LIVE_BACKEND_UNAVAILABLE" });
    assertNoLifecycle();
    console.log("ok - unavailable backend fails without starting or reconciling a process");

    const previous = path.join(root, ".shoggoth-media-smoke");
    fs.mkdirSync(previous);
    fs.writeFileSync(path.join(previous, "probe.png"), "user-owned");
    const active = new Set();
    await Promise.all([1, 2].map(() => withMediaFixture(root, async ({ png, text }) => {
      assert.equal(fs.existsSync(png), true);
      assert.equal(fs.existsSync(text), true);
      const directory = path.dirname(png);
      assert.equal(active.has(directory), false);
      active.add(directory);
      await new Promise((resolve) => setTimeout(resolve, 5));
    })));
    assert.equal(active.size, 2);
    for (const directory of active) assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.readFileSync(path.join(previous, "probe.png"), "utf8"), "user-owned");
    console.log("ok - concurrent media probes own unique files and preserve prior files");

    const before = fs.readdirSync(root);
    await assert.rejects(withMediaFixture(root, async () => { throw new Error("request failed"); }), /request failed/);
    assert.deepEqual(fs.readdirSync(root), before);
    console.log("ok - media request failure removes only the owned temporary directory");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("9 CRUD smoke safety tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
