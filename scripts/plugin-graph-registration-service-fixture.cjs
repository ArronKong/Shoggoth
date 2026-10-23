"use strict";

// An isolated loopback App request crosses REST, Backend, authenticated Service
// RPC, native confirmation, and the private Microsoft Graph client-ID file.
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
const { FILE_NAME } = require("../app/agent-service/plugin-graph-registration");
const { loadOutlookCalendarConfig } = require("../app/agent-service/outlook-calendar-graph");

const CLIENT_ID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
const NORMALIZED_ID = CLIENT_ID.toLowerCase();
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const STATUS_METHOD = "plugins.graph.registration.status";
const CONFIGURE_METHOD = "plugins.graph.registration.configure";
const ACCOUNT_REF = "microsoft-graph-calendar-shared-v1";

function safeStorage(key) {
  return { isEncryptionAvailable: () => true,
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
}

function fixture(name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sg-graph-${name}-`)));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32);
  const options = { paths, safeStorage: safeStorage(key), parentEnv: {},
    prewarmMcpAuth: false, version: "plugin-graph-registration-fixture" };
  return { root, paths, key, options, file: path.join(paths.pluginsDir, FILE_NAME) };
}

async function withApp(name, run, prepare) {
  const context = fixture(name);
  let service, web;
  try {
    if (prepare) prepare(context);
    service = createAgentService(context.options);
    await service.start();
    const backend = new ShoggothBackend({ paths: context.paths });
    const registry = { backends: new Map([["shoggoth", backend]]) };
    let approve = false;
    const confirmations = [];
    web = await startStaticServer(0, { homeDir: context.root, userDataRoot: context.root,
      registry, hostOps: { async confirmPluginCapability(summary) {
        confirmations.push(summary);
        return approve;
      } } });
    const post = async (route, body, extraHeaders = {}) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin: web.url, "content-type": "application/json", ...extraHeaders },
        body: JSON.stringify(body) });
      const raw = await response.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      return { status: response.status, body: parsed };
    };
    const rpc = (method, params, token = readClientToken(context.paths)) =>
      requestService(context.paths, { token, version: SERVICE_PROTOCOL_VERSION, method, params });
    await run({ ...context, backend, registry, post, rpc, confirmations,
      get service() { return service; },
      async restart() {
        await service.stop({ notify: false });
        service = createAgentService(context.options);
        await service.start();
      },
      approve() { approve = true; } });
  } finally {
    await web?.close();
    if (service) await service.stop({ notify: false });
    context.key.fill(0);
    fs.rmSync(context.root, { recursive: true, force: true });
  }
}

async function testFirstRegistration() {
  await withApp("fresh", async ({ paths, file, root, backend, registry, post, rpc,
    confirmations, approve, restart }) => {
    const status = () => post("graph-registration-status", {});
    const configure = (body = { clientId: CLIENT_ID }, headers = {}) =>
      post("graph-registration-configure", body, headers);
    const empty = { configured: false, restartRequired: false };
    const pending = { configured: true, restartRequired: true };
    assert.deepEqual(await status(), { status: 200, body: empty });
    assert.deepEqual(await backend.getPluginGraphRegistrationStatus(), empty);
    assert.deepEqual(await rpc(STATUS_METHOD, {}), empty);
    await assert.rejects(rpc(STATUS_METHOD, {}, "wrong"), { code: "AUTH_FAILED" });
    await assert.rejects(rpc(STATUS_METHOD, { extra: true }),
      { code: "PLUGIN_REQUEST_INVALID" });

    const noNative = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry });
    try {
      const response = await fetch(`${noNative.url}/__api/plugins/graph-registration-configure`, {
        method: "POST", headers: { origin: noNative.url, "content-type": "application/json" },
        body: JSON.stringify({ clientId: CLIENT_ID }) });
      assert.equal(response.status, 501, "missing native confirmation must fail closed");
    } finally { await noNative.close(); }
    assert.equal((await configure(undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await configure(undefined, { "sec-fetch-site": "cross-site" })).status, 403);
    for (const bad of [{ clientId: "not-a-guid" },
      { clientId: CLIENT_ID, clientSecret: "must-not-be-accepted" },
      { clientId: CLIENT_ID, scopes: ["Sites.Read.All"] },
      { clientId: CLIENT_ID, redirectPort: 39742 }]) {
      assert.equal((await configure(bad)).status, 400);
      await assert.rejects(rpc(CONFIGURE_METHOD, bad),
        { code: "GRAPH_REGISTRATION_INVALID" });
      assert.equal(fs.existsSync(file), false);
    }
    assert.equal(confirmations.length, 0, "invalid input must not request native approval");
    assert.deepEqual(await configure(), { status: 200,
      body: { canceled: true, ...empty } },
      "native cancellation leaves registration untouched");
    assert.deepEqual(await status(), { status: 200, body: empty });
    assert.equal(fs.existsSync(file), false);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].action, "graph-registration");
    assert.equal(confirmations[0].provider, "Microsoft Graph");
    assert.equal(confirmations[0].clientId, CLIENT_ID);
    assert.equal(confirmations[0].redirectUrl, "http://localhost");
    assert(Array.isArray(confirmations[0].scopes));
    assert.equal(Object.hasOwn(confirmations[0], "clientSecret"), false);
    assert.equal(Object.hasOwn(confirmations[0], "redirectPort"), false);

    approve();
    assert.deepEqual(await configure(), { status: 200,
      body: { canceled: false, ...pending } });
    assert.deepEqual(await status(), { status: 200, body: pending });
    assert.deepEqual(await backend.getPluginGraphRegistrationStatus(), pending);
    assert.deepEqual(await rpc(STATUS_METHOD, {}), pending);
    assert.equal(confirmations.length, 2);
    assert.equal(confirmations[1].action, "graph-registration");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")),
      { version: 1, clientId: NORMALIZED_ID });
    assert.deepEqual(loadOutlookCalendarConfig(paths), { clientId: NORMALIZED_ID });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.pluginsDir).mode & 0o777, 0o700);
    const original = fs.readFileSync(file);
    assert.equal((await configure({ clientId: OTHER_ID })).status, 409);
    await assert.rejects(rpc(CONFIGURE_METHOD, { clientId: OTHER_ID }),
      { code: "GRAPH_REGISTRATION_CONFLICT" });
    assert.equal(confirmations.length, 2, "overwrite cannot reach native confirmation");
    assert.deepEqual(fs.readFileSync(file), original);

    await restart();
    const active = { configured: true, restartRequired: false };
    assert.deepEqual(await status(), { status: 200, body: active });
    assert.deepEqual(await backend.getPluginGraphRegistrationStatus(), active);
    assert.deepEqual(await rpc(STATUS_METHOD, {}), active);
  });
}

async function testStoredAccountGate() {
  await withApp("account", async ({ service, file, backend, post, rpc, confirmations, approve }) => {
    await service.secretStore.put(ACCOUNT_REF, "fixture-existing-account",
      { kind: "microsoft-graph-oauth" });
    assert.equal(service.outlookCalendarGraph.hasStoredAccount(), true);
    await assert.rejects(rpc(STATUS_METHOD, {}), { code: "GRAPH_REGISTRATION_CONFLICT" });
    await assert.rejects(backend.getPluginGraphRegistrationStatus(),
      { code: "GRAPH_REGISTRATION_CONFLICT" });
    assert.equal((await post("graph-registration-status", {})).status, 409);
    await assert.rejects(rpc(CONFIGURE_METHOD, { clientId: CLIENT_ID }),
      { code: "GRAPH_REGISTRATION_CONFLICT" });
    approve();
    assert.equal((await post("graph-registration-configure", { clientId: CLIENT_ID })).status, 409);
    assert.equal(confirmations.length, 0, "retained account must block before native confirmation");
    assert.equal(fs.existsSync(file), false);
  });
}

async function testBadPrivateConfig() {
  await withApp("corrupt", async ({ file, post, rpc, confirmations }) => {
    const original = fs.readFileSync(file);
    await assert.rejects(rpc(STATUS_METHOD, {}),
      { code: "OUTLOOK_CALENDAR_CONFIG_INVALID" });
    assert.equal((await post("graph-registration-status", {})).status, 409);
    assert.equal((await post("graph-registration-configure", { clientId: CLIENT_ID })).status, 409);
    assert.equal(confirmations.length, 0);
    assert.deepEqual(fs.readFileSync(file), original);
  }, ({ paths, file }) => {
    fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '{"version":1,"clientId":"invalid"}\n', { mode: 0o600 });
  });
}

async function main() {
  await testFirstRegistration();
  await testStoredAccountGate();
  await testBadPrivateConfig();
  console.log("Microsoft Graph registration REST / Backend / authenticated Service / native confirmation fixture: PASS");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
