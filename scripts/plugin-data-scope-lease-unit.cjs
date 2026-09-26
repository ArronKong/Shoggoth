"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");
const { resolveServicePaths } = require("../app/agent-service/paths");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-data-"));
const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), trustedRoot: temp });
const manager = new PluginDataScopeLeaseManager({ paths });
const canonicalRoot = fs.realpathSync(temp);
const anotherManager = new PluginDataScopeLeaseManager({ paths: resolveServicePaths({
  stateRoot: path.join(canonicalRoot, "state"), trustedRoot: canonicalRoot,
}) });
const installationId = "local-plugin-1";
const accountA = "b".repeat(64);
const accountB = "c".repeat(64);
const fixture = path.join(__dirname, "fixtures/plugins/mcp-data-lease-fixture.cjs");

function connect(scopeId = accountA, overrides = {}) {
  return PluginMcpClient.connectStdio({ command: process.execPath,
    args: [fixture], cwd: __dirname, env: { PATH: process.env.PATH },
    connectionId: "fixture-connection", principalIdentity: "fixture-principal",
    authorizeEgress: () => true, timeoutMs: 3000,
    dataScope: { leaseManager: manager, installationId, scopeId }, ...overrides });
}

async function main() {
  try {
    await assert.rejects(connect(accountA, { dataScope: undefined }),
      (error) => error.code === "PLUGIN_DATA_SCOPE_INVALID");
    await assert.rejects(connect(accountA, { env: { PLUGIN_DATA: temp } }),
      (error) => error.code === "MCP_SERVER_START_FAILED");
    await assert.rejects(connect("../outside"),
      (error) => error.code === "PLUGIN_DATA_SCOPE_INVALID");

    const first = await connect();
    let second;
    try {
      const firstResult = await first.callTool("echo", { value: "first" }, { runId: "one" });
      const firstDirectory = firstResult.structuredContent.dataDirectory;
      assert.equal(firstDirectory,
        fs.realpathSync(path.join(paths.pluginDataDir, installationId, accountA)));
      assert.equal(fs.statSync(firstDirectory).mode & 0o077, 0);
      await assert.rejects(connect(accountA, { connectionId: "rotated-token",
        dataScope: { leaseManager: anotherManager, installationId, scopeId: accountA } }),
      (error) => error.code === "PLUGIN_DATA_WRITER_ACTIVE");
      second = await connect(accountB);
      const secondResult = await second.callTool("echo", { value: "second" }, { runId: "two" });
      assert.notEqual(secondResult.structuredContent.dataDirectory, firstDirectory);
      assert.notEqual(secondResult.structuredContent.pid, firstResult.structuredContent.pid);

      const closing = first.close();
      await assert.rejects(connect(accountA),
        (error) => error.code === "PLUGIN_DATA_WRITER_ACTIVE");
      await closing;
      const successor = await connect(accountA);
      try {
        const result = await successor.callTool("echo", { value: "successor" }, { runId: "three" });
        assert.equal(result.structuredContent.dataDirectory, firstDirectory);
        assert.notEqual(result.structuredContent.pid, firstResult.structuredContent.pid);
      } finally { await successor.close(); }
    } finally { await first.close(); await second?.close(); }

    const unexpected = await connect(accountA);
    await unexpected.callTool("echo", { value: "exit" }, { runId: "four" });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const check = () => {
        try {
          const lease = anotherManager.acquire({ installationId, scopeId: accountA });
          lease.release();
          resolve();
        } catch (error) {
          if (error.code !== "PLUGIN_DATA_WRITER_ACTIVE" || Date.now() > deadline) reject(error);
          else setTimeout(check, 25);
        }
      };
      check();
    });
    await unexpected.close();

    await assert.rejects(connect(accountA, { args: [path.join(temp, "missing.cjs")] }));
    const afterFailedStart = await connect(accountA);
    await afterFailedStart.close();

    const blockedScope = "d".repeat(64);
    const installDir = path.join(paths.pluginDataDir, installationId);
    fs.symlinkSync(temp, path.join(installDir, blockedScope));
    assert.throws(() => manager.acquire({ installationId, scopeId: blockedScope }),
      (error) => error.code === "UNSAFE_SYMLINK");
    console.log("plugin data scope writer lease: PASS");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
