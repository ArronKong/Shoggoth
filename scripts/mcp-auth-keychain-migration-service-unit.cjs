"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { InProcessMcpCryptoBroker } = require("../app/agent-service/mcp-crypto-broker");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { DEFAULT_RUNTIME_PROFILE_ID } = require("../app/agent-service/product-store");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value),
  decryptString: value => value.toString(),
};
async function fixture(migrate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-migrate-api-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const broker = new InProcessMcpCryptoBroker({ paths, callerRole: "agent-service", safeStorage });
  broker.migrateLegacyMcpAuth = migrate;
  const service = createAgentService({ paths, version: "migration-test", cryptoBroker: broker });
  await service.start();
  const call = (params, token = readClientToken(paths)) => requestService(paths, {
    token, version: PROTOCOL_VERSION, method: "service.mcpAuth.migrateKeychain", params,
  });
  const challenge = () => requestService(paths, { version: PROTOCOL_VERSION, method: "mcp.auth.challenge", params: {
    protocolVersion: PROTOCOL_VERSION, runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    clientNonce: Buffer.alloc(32, 9).toString("base64url"),
  } });
  return { paths, service, broker, call, challenge, async close() {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test("migration requires authentication and confirmation; concurrent calls share one operation", async () => {
  let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const value = await fixture(async () => { calls++; await pending; return { migrated: true, restartRequired: true }; });
  try {
    await assert.rejects(value.call({ confirm: true }, "wrong-token"), { code: "AUTH_FAILED" });
    for (const params of [{}, { confirm: false }, { confirm: true, extra: true }]) {
      await assert.rejects(value.call(params), { code: "INVALID_PARAMS" });
    }
    assert.equal(calls, 0);
    const first = value.call({ confirm: true });
    const second = value.call({ confirm: true });
    for (let attempt = 0; calls === 0 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    await assert.rejects(value.challenge(), { code: "SERVICE_UNAVAILABLE" });
    release();
    assert.deepEqual(await first, { migrated: true, restartRequired: true });
    assert.deepEqual(await second, { migrated: true, restartRequired: true });
    await value.call({ confirm: true });
    assert.equal(calls, 1);
    await assert.rejects(value.challenge(), { code: "SERVICE_UNAVAILABLE" });
  } finally { release(); await value.close(); }
});

test("migration rejects active work and an already unlocked MCP manager", async () => {
  let calls = 0;
  const value = await fixture(async () => { calls++; return { migrated: true }; });
  const listRuns = value.service.workRunCoordinator.listRuns.bind(value.service.workRunCoordinator);
  try {
    value.service.workRunCoordinator.listRuns = () => [{ id: "active", status: "running", source: "chat" }];
    await assert.rejects(value.call({ confirm: true }), { code: "MCP_AUTH_MIGRATION_BUSY" });
    value.service.workRunCoordinator.listRuns = listRuns;
    await value.challenge();
    await assert.rejects(value.call({ confirm: true }), { code: "MCP_AUTH_MIGRATION_BUSY" });
    assert.equal(calls, 0);
  } finally { value.service.workRunCoordinator.listRuns = listRuns; await value.close(); }
});

test("migration failures are redacted and do not prompt again within a generation", async () => {
  let calls = 0;
  const value = await fixture(async () => { calls++; throw new Error("secret-error-canary"); });
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(value.call({ confirm: true }), error =>
      error.code === "MCP_CRYPTO_UNAVAILABLE" && error.message === "mcp_crypto_unavailable");
    assert.equal(calls, 1);
    const status = await requestService(value.paths, { token: readClientToken(value.paths),
      version: PROTOCOL_VERSION, method: "service.status", params: {} });
    assert.equal(status.healthy, true);
  } finally { await value.close(); }
});

test("the ordinary client allows the explicit Keychain authorization window", async () => {
  const value = await fixture(async () => {
    await new Promise(resolve => setTimeout(resolve, 2_200));
    return { migrated: true };
  });
  try {
    assert.deepEqual(await value.call({ confirm: true }), { migrated: true, restartRequired: true });
  } finally { await value.close(); }
});

test("migration rejects an in-flight MCP handshake", async () => {
  let release, entered = false, calls = 0;
  const value = await fixture(async () => { calls++; return { migrated: true }; });
  value.broker.loadOrCreateForService = () => {
    entered = true;
    return new Promise(resolve => { release = () => resolve(Buffer.alloc(32, 7)); });
  };
  let handshake;
  try {
    handshake = value.challenge();
    for (let i = 0; !entered && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(entered, true);
    await assert.rejects(value.call({ confirm: true }), { code: "MCP_AUTH_MIGRATION_BUSY" });
    assert.equal(calls, 0);
    release();
    await handshake;
  } finally { release?.(); await Promise.allSettled([handshake]); await value.close(); }
});

test("the commit guard rejects new work or a retired service generation", async () => {
  for (const change of ["new-work", "stop"]) {
    let guard, release;
    const pending = new Promise(resolve => { release = resolve; });
    const value = await fixture(async ({ isCurrent }) => {
      guard = isCurrent;
      await pending;
      if (!isCurrent()) throw new Error("retired");
      return { migrated: true };
    });
    const listRuns = value.service.workRunCoordinator.listRuns.bind(value.service.workRunCoordinator);
    let stopping;
    try {
      const result = value.call({ confirm: true }).then(() => ({ ok: true }), error => ({ error }));
      for (let i = 0; !guard && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(guard(), true);
      if (change === "new-work") {
        value.service.workRunCoordinator.listRuns = () => [{ id: "new", status: "running", source: "chat" }];
      } else {
        stopping = value.service.stop({ notify: false });
        for (let i = 0; guard() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(guard(), false);
      release();
      assert.equal((await result).ok, undefined, "retired migration must not report success");
      await stopping;
    } finally {
      release();
      value.service.workRunCoordinator.listRuns = listRuns;
      await stopping;
      await value.close();
    }
  }
});
