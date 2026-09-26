"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { createConfigStore } = require("../app/core/config-store");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");

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
    const read = async () => (await (await fetch(`${server.url}/__api/runtime-status`)).json()).runtimes;
    const rows = await read();
    assert.equal(rows.length, 7);
    assert.ok(rows.every(row => row.backendId === "shoggoth"));
    assert.equal(rows.find(row => row.runtime === "pi").enabled, false);
    assert.equal(rows.find(row => row.runtime === "claude-code").releaseEnabled, false);
    assert.equal(rows.find(row => row.runtime === "codex").installation, "available");
    assert.ok(!JSON.stringify(rows).includes(home));
    installed = false; connected = false;
    const refreshed = await read();
    assert.equal(refreshed.find(row => row.runtime === "codex").installation, "unavailable");
    assert.ok(refreshed.every(row => row.serviceConnected === false));
    assert.equal((await fetch(`${server.url}/__api/runtime-status`, { method: "POST" })).status, 405);
    console.log("Runtime status REST passed: seven runtimes, one facade, disabled/release/missing/offline, refreshed detection, no credentials or runtime calls.");
  } finally { await server?.close(); fs.rmSync(home, { recursive: true, force: true }); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
