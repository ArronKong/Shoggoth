"use strict";
// Real Electron transport/parent verification and production crypto operations.
// A private file key is injected in place of Keychain; no account or model call.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
if (!process.versions.electron) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "send-crypto-electron-")));
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require("electron"), [__filename, "--shoggoth-internal-role=agent-service", root], {
      env, stdio: "inherit", timeout: 120_000,
    });
    assert.equal(result.status, 0, String(result.error || result.signal || "Electron fixture failed"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { app } = require("electron"), root = process.argv.at(-1);
  assert.equal(fs.realpathSync(root), root); assert.match(path.basename(root), /^send-crypto-electron-/u);
  app.setPath("userData", path.join(root, "parent")); app.setPath("sessionData", path.join(root, "parent-session"));
  app.setPath("cache", path.join(root, "parent-cache"));
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  const deadline = setTimeout(() => app.exit(2), 110_000);
  if (process.env.SHOGGOTH_FIXTURE_CRYPTO_CHILD === "1") {
    const { startMcpCryptoWorker } = require("../app/mcp-crypto-worker");
    const { createLocalFileSafeStorage } = require("../app/agent-service/local-file-safe-storage");
    startMcpCryptoWorker({ safeStorage: createLocalFileSafeStorage({ paths }), runtime: { appRoot: ROOT } })
      .then(() => app.exit(0)).catch(error => { console.error(error.code); app.exit(1); });
  } else {
    const { McpCryptoBroker } = require("../app/agent-service/mcp-crypto-broker");
    (async () => {
      const report = { cold: [], warm: [], workers: {}, payloadBytes: 400 * 1024, samples: 20 };
      for (const persistent of [false, true]) {
        const children = [], key = persistent ? "warm" : "cold";
        const broker = new McpCryptoBroker({ paths, persistent, callerRole: "agent-service",
          executablePath: process.execPath, appRoot: ROOT, defaultApp: true,
          spawn(executable, _args, options) {
            const child = spawn(executable, [__filename, "--shoggoth-internal-role=mcp-crypto", root], {
              ...options, env: { ...options.env, SHOGGOTH_FIXTURE_CRYPTO_CHILD: "1" },
            }); children.push(child); return child;
          },
        }).open({ generation: 1 });
        try {
          if (persistent) await broker.encrypt(Buffer.from("prime"));
          for (let i = 0; i < report.samples; i++) {
            const plain = Buffer.alloc(report.payloadBytes, i + 1), at = performance.now();
            const encrypted = await broker.encrypt(plain); report[key].push(performance.now() - at);
            assert.deepEqual(await broker.decrypt(encrypted), plain);
            plain.fill(0); encrypted.fill(0);
          }
        } finally { await broker.close(); }
        assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
        report.workers[key] = children.length;
      }
      assert.equal(report.workers.cold, 40); assert.equal(report.workers.warm, 1);
      for (const key of ["cold", "warm"]) {
        const values = report[key].sort((a, b) => a - b);
        report[key] = { p50: Math.round(values[10]), p90: Math.round(values[18]), min: Math.round(values[0]), max: Math.round(values.at(-1)) };
      }
      console.log("PASS real Electron crypto transport and lifecycle", JSON.stringify(report));
      clearTimeout(deadline); app.exit(0);
    })().catch(error => { console.error(error.stack); clearTimeout(deadline); app.exit(1); });
  }
}
