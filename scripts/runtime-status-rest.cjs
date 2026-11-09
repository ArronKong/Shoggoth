"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { createConfigStore } = require("../app/core/config-store");
const { DEFAULT_RUNTIME_ACCOUNTS, NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

async function run() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-status-"));
  let server;
  try {
    let installed = true, connected = true;
    const backend = new ShoggothBackend({ paths: {}, getRuntimeCliAuth: () => DEFAULT_RUNTIME_ACCOUNTS
      .filter(account => account.kind === "native-user").map(account => ({
        runtime: account.runtime, runtimeAccountId: account.id, name: account.runtime,
        binaryPath: installed ? path.join(home, account.runtime) : null,
        unavailableReason: "fixture executable unavailable", accountHome: home, processHome: home,
        homeEnv: null, accountKind: "native-user", credentialProbe: "runtime", credentialFile: null,
        loginArgs: [], logoutArgs: [], docsUrl: "https://example.invalid/",
      })), requestService: () => { throw Error("Status must not start runtimes or authentication"); } });
    backend.getStatus = async () => ({ connected });
    const registry = new BackendRegistry();
    registry.register(backend);
    // A failed capability owner must not hide another owner's inventory.
    registry.register({ id: "broken", name: "Broken", getBackendDescriptor: () => ({ surfaces: { runtimeStatus: true } }),
      getRuntimeStatuses: async () => { throw Error("private failure"); } });
    backend.setDisabledBackendsProvider(() => ["pi"]);
    server = await startStaticServer(0, { registry, homeDir: home, userDataRoot: path.join(home, "data"),
      configStore: createConfigStore(path.join(home, "config.json")) });
    const read = async (query = "", options) => (await (await fetch(`${server.url}/__api/runtime-status${query}`, options)).json()).runtimes;
    const rows = await read();
    assert.equal(rows.length, 7);
    assert.ok(rows.every(row => row.backendId === "shoggoth"));
    assert.ok(rows.every(row => row.readiness === "unverified"), "installation without a proof is never Ready");
    assert.equal(rows.find(row => row.runtime === "pi").enabled, false);
    assert.equal(rows.find(row => row.runtime === "claude-code").releaseEnabled, false);
    assert.equal(rows.find(row => row.runtime === "codex").installation, "available");
    assert.deepEqual(backend._bindingAvailability("shoggoth-codex", "codex", NATIVE_CODEX_RUNTIME_ACCOUNT_ID),
      { available: true, reason: null });
    assert.ok(!JSON.stringify(rows).includes(home));
    // Only Antigravity installs itself from its sign-in.
    assert.deepEqual(rows.filter(row => row.installsOnSignIn).map(row => row.runtime), ["antigravity"]);
    installed = false; connected = false;
    const refreshed = await read();
    assert.equal(refreshed.find(row => row.runtime === "codex").installation, "unavailable");
    assert.equal(refreshed.find(row => row.runtime === "antigravity").installsOnSignIn, true);
    assert.deepEqual(backend._bindingAvailability("shoggoth-codex", "codex", NATIVE_CODEX_RUNTIME_ACCOUNT_ID),
      { available: false, reason: "runtime-not-installed" });
    assert.throws(() => backend._assertRuntimeEnabled({ agentId: "shoggoth-codex", runtime: "codex",
      runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID }), { code: "RUNTIME_NOT_INSTALLED" });
    assert.deepEqual(backend._bindingAvailability("shoggoth-default", "codex", SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID),
      { available: true, reason: null });
    backend._state = "started";
    backend._agents = [
      { id: "shoggoth-default", runtime: "codex", runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID },
      { id: "shoggoth-codex", runtime: "codex", runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID },
    ];
    assert.deepEqual(backend._statusResult().info.readyAgentIds, ["shoggoth-default"]);
    assert.ok(refreshed.every(row => row.serviceConnected === false));
    assert.equal((await fetch(`${server.url}/__api/runtime-status`, { method: "POST" })).status, 405);

    installed = true;
    const calls = [];
    const probeStarted = Promise.withResolvers();
    const releaseProbe = Promise.withResolvers();
    backend.getStatus = async () => { calls.push("health"); return { connected: true }; };
    backend.listOAuthProviders = async () => {
      calls.push("accounts");
      probeStarted.resolve();
      await releaseProbe.promise;
      return { providers: [{ id: NATIVE_CODEX_RUNTIME_ACCOUNT_ID, status: { readiness: "ready" } }] };
    };
    backend._ensureBuiltinAgents = async () => { calls.push("builtin-agents"); return null; };
    backend._refreshExtensionRuntimeStatuses = async () => {
      calls.push("extensions");
      return [{ runtime: "ext-fixture", runtimeAccountId: "fixture-extension", enabled: true, availability: "available" }];
    };
    const full = read("", { signal: AbortSignal.timeout(5_000) });
    try {
      await Promise.race([probeStarted.promise, full.then(() => assert.fail("Settings must run the readiness probe"))]);
      const choices = await read("?view=agent-create", { signal: AbortSignal.timeout(2_000) });
      assert.deepEqual(calls, ["health", "accounts"], "creating must not join the probes, read the Service or provision Agents");
      assert.equal(choices.length, 7);
      assert.equal(choices.find(row => row.runtime === "codex").installation, "available");
      assert.equal(choices.find(row => row.runtime === "codex").readiness, "unverified");
      assert.equal(choices.find(row => row.runtime === "pi").enabled, false);
    } finally {
      releaseProbe.resolve();
      await full;
    }
    const detailed = await full;
    assert.deepEqual(calls, ["health", "accounts", "builtin-agents", "extensions"]);
    assert.equal(detailed.find(row => row.runtime === "codex").readiness, "ready");
    assert.equal(detailed.find(row => row.runtime === "ext-fixture").installation, "available");
    console.log("Runtime status REST passed: inventory, release/connection filtering, fresh detection, and creation while Settings probes are pending.");
  } finally { await server?.close(); fs.rmSync(home, { recursive: true, force: true }); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
