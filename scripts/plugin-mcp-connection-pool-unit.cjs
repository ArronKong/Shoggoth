"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");
const { PluginMcpConnectionPool } = require("../app/agent-service/plugin-mcp-connection-pool");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { handle } = require("./fixtures/plugins/mcp-sdk-fixture.cjs");

async function localHttpServer() {
  const state = { calls: 0, methods: [], callAccounts: [] };
  const accounts = new Map([["Bearer token-a", "account-a"],
    ["Bearer token-a-rotated", "account-a"], ["Bearer token-b", "account-b"]]);
  const server = http.createServer(async (request, response) => {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405); response.end(); return;
    }
    const account = accounts.get(request.headers.authorization);
    if (!account) { response.writeHead(401); response.end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    state.methods.push(message.method);
    const result = handle(message, "2025-11-25", state);
    if (!result) { response.writeHead(202); response.end(); return; }
    if (message.method === "tools/call") {
      state.callAccounts.push(account);
      result.result.structuredContent.account = account;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

function provider(readToken, principalIdentity, authRevision) {
  const credential = async () => ({ accessToken: readToken(), principalIdentity, authRevision });
  credential.assertCurrent = () => {};
  return credential;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-pool-"));
const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), trustedRoot: temp });
const installationId = "local-plugin-1";
const scopeId = "b".repeat(64);
const fixture = path.join(__dirname, "fixtures/plugins/mcp-data-lease-fixture.cjs");
let admissions = 0;
const invalidated = [];
const pool = new PluginMcpConnectionPool({
  leaseManager: new PluginDataScopeLeaseManager({ paths }),
  authorizeEgress: () => { admissions += 1; return true; },
  onConnectionInvalidated: ({ connectionId }) => invalidated.push(connectionId),
});
const options = { installationId, scopeId, releaseDigest: "c".repeat(64),
  componentId: "mcp-echo", connectionId: "account-a-connection",
  principalIdentity: "account-a", authRevision: 1, executionScope: "shared-account-a",
  command: process.execPath, args: [fixture], cwd: __dirname,
  env: { PATH: process.env.PATH }, timeoutMs: 3000 };

async function main() {
  try {
    await assert.rejects(pool.acquireStdio({ ...options, principalIdentity: "" }),
      (error) => error.code === "PLUGIN_CONNECTION_IDENTITY_INVALID");
    const [agentA, agentB] = await Promise.all([
      pool.acquireStdio(options), pool.acquireStdio(options),
    ]);
    try {
      const a = await agentA.callTool("echo", { value: "agent-a" }, { runId: "a" });
      const b = await agentB.callTool("echo", { value: "agent-b" }, { runId: "b" });
      assert.equal(a.structuredContent.pid, b.structuredContent.pid);
      assert.equal(admissions, 2);

      await assert.rejects(pool.acquireStdio({ ...options, authRevision: 2 }),
        (error) => error.code === "ACTIVATION_DEFERRED");
      await assert.rejects(agentA.callTool("echo", { value: "after-drain" }, { runId: "a" }),
        (error) => error.code === "PLUGIN_CONNECTION_CLOSED");
      await agentA.release();
      await assert.rejects(pool.acquireStdio({ ...options, authRevision: 2 }),
        (error) => error.code === "ACTIVATION_DEFERRED");
      await agentB.release();
      const rotated = await pool.acquireStdio({ ...options, authRevision: 2 });
      try {
        const value = await rotated.callTool("echo", { value: "rotated" }, { runId: "c" });
        assert.equal(value.structuredContent.dataDirectory,
          fs.realpathSync(path.join(paths.pluginDataDir, installationId, scopeId)));
        assert.notEqual(value.structuredContent.pid, a.structuredContent.pid);
      } finally { await rotated.release(); }
      await pool.drainScope({ installationId, scopeId });
    } finally { await agentA.release(); await agentB.release(); }

    const inFlight = await pool.acquireStdio(options);
    const slowCall = inFlight.callTool("echo", { value: "slow" }, { runId: "in-flight" });
    await assert.rejects(pool.acquireStdio({ ...options, authRevision: 2 }),
      (error) => error.code === "ACTIVATION_DEFERRED");
    const releaseInFlight = inFlight.release();
    await assert.rejects(pool.acquireStdio({ ...options, authRevision: 2 }),
      (error) => error.code === "ACTIVATION_DEFERRED");
    assert.equal((await slowCall).structuredContent.echoed, "slow");
    await releaseInFlight;
    const afterCall = await pool.acquireStdio({ ...options, authRevision: 2 });
    await afterCall.release();
    await pool.drainScope({ installationId, scopeId });

    const starting = pool.acquireStdio({ ...options, authRevision: 3 });
    await assert.rejects(pool.acquireStdio({ ...options, authRevision: 4 }),
      (error) => error.code === "ACTIVATION_DEFERRED");
    await assert.rejects(starting,
      (error) => error.code === "ACTIVATION_DEFERRED");
    const finalGeneration = await pool.acquireStdio({ ...options, authRevision: 4 });
    await finalGeneration.release();
    await pool.drainScope({ installationId, scopeId });

    const accountA = await pool.acquireStdio(options);
    const accountB = await pool.acquireStdio({ ...options,
      scopeId: "d".repeat(64), connectionId: "account-b-connection",
      principalIdentity: "account-b", executionScope: "shared-account-b" });
    try {
      const first = await accountA.callTool("echo", { value: "account-a" }, { runId: "d" });
      const second = await accountB.callTool("echo", { value: "account-b" }, { runId: "e" });
      assert.notEqual(first.structuredContent.pid, second.structuredContent.pid);
      assert.notEqual(first.structuredContent.dataDirectory,
        second.structuredContent.dataDirectory);
    } finally {
      await accountA.release(); await accountB.release();
      await pool.drainScope({ installationId, scopeId });
      await pool.drainScope({ installationId, scopeId: "d".repeat(64) });
    }

    const targetInstallation = await pool.acquireStdio(options);
    const separateInstallation = await pool.acquireStdio({ ...options,
      installationId: "local-plugin-2", connectionId: "other-installation",
      executionScope: "other-installation" });
    try {
      const beforeDrain = invalidated.length;
      await assert.rejects(pool.drainInstallation(installationId),
        (error) => error.code === "ACTIVATION_DEFERRED");
      assert.deepEqual(invalidated.slice(beforeDrain), [options.connectionId],
        "a deferred drain invalidates only the targeted Connection immediately");
      await assert.rejects(targetInstallation.listTools(),
        (error) => error.code === "PLUGIN_CONNECTION_CLOSED");
      await assert.rejects(pool.acquireStdio(options),
        (error) => error.code === "PLUGIN_COMPONENT_INACTIVE");
      assert(Array.isArray(await separateInstallation.listTools()),
        "draining one package must not close an unrelated installation");
    } finally {
      await targetInstallation.release();
      await separateInstallation.release();
      await pool.drainInstallation(installationId);
      await pool.drainInstallation("local-plugin-2");
      pool.resumeInstallation(installationId);
    }

    const dying = await pool.acquireStdio(options);
    const beforeUnexpectedExit = invalidated.length;
    const exitResult = await dying.callTool("echo", { value: "exit" }, { runId: "f" });
    await dying.release();
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert(invalidated.length > beforeUnexpectedExit,
      "an unexpected child exit invalidates its previous tool catalog");
    const deadline = Date.now() + 3000;
    let replacement;
    while (!replacement) {
      try { replacement = await pool.acquireStdio(options); }
      catch (error) {
        if (error.code !== "ACTIVATION_DEFERRED" || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const replacementResult = await replacement.callTool("echo", { value: "recovered" },
      { runId: "g" });
    assert.notEqual(replacementResult.structuredContent.pid,
      exitResult.structuredContent.pid);
    await replacement.release();
    await pool.drainScope({ installationId, scopeId });

    const crashing = await pool.acquireStdio(options);
    const crashedCall = crashing.callTool("echo", { value: "crash" },
      { runId: "crash-first" });
    const queuedAfterCrash = crashing.callTool("echo", { value: "queued" },
      { runId: "crash-queued" });
    const crashedOutcome = assert.rejects(crashedCall);
    await assert.rejects(queuedAfterCrash,
      (error) => error.code === "MCP_SERVER_EXITED",
      "a queued call must fail as soon as its child exits");
    await crashedOutcome;
    await crashing.release();
    await pool.drainScope({ installationId, scopeId });

    const fixtureHttp = await localHttpServer();
    const handles = [];
    let tokenA = "token-a";
    const providerA = provider(() => tokenA, "account-a", 1);
    const httpA = { installationId, releaseDigest: "c".repeat(64),
      componentId: "mcp-http", connectionId: "connection-a",
      principalIdentity: "account-a", authRevision: 1, executionScope: "account-a",
      url: fixtureHttp.url, allowLoopback: true, credentialProvider: providerA,
      timeoutMs: 3000 };
    const httpB = { ...httpA, connectionId: "connection-b",
      principalIdentity: "account-b", executionScope: "account-b",
      credentialProvider: provider(() => "token-b", "account-b", 1) };
    try {
      const [first, shared] = await Promise.all([
        pool.acquireHttp(httpA), pool.acquireHttp(httpA),
      ]);
      handles.push(first, shared);
      assert.equal(fixtureHttp.state.methods.filter((method) => method === "initialize").length, 1);
      assert.equal((await first.callTool("echo", { value: "first" }, { runId: "http-a" }))
        .structuredContent.account, "account-a");
      tokenA = "token-a-rotated";
      assert.equal((await shared.callTool("echo", { value: "refreshed" }, { runId: "http-a" }))
        .structuredContent.account, "account-a");
      assert.equal(fixtureHttp.state.methods.filter((method) => method === "initialize").length, 1);

      const otherAccount = await pool.acquireHttp(httpB);
      handles.push(otherAccount);
      assert.equal((await otherAccount.callTool("echo", { value: "second" }, { runId: "http-b" }))
        .structuredContent.account, "account-b");
      const badHttp = { ...httpA, connectionId: "connection-bad",
        credentialProvider: provider(() => "invalid-token", "account-a", 1) };
      const failedStarts = await Promise.allSettled([
        pool.acquireHttp(badHttp), pool.acquireHttp(badHttp),
      ]);
      assert.ok(failedStarts.every((result) => result.status === "rejected"));
      const recovered = await pool.acquireHttp({ ...badHttp,
        credentialProvider: provider(() => tokenA, "account-a", 1) });
      handles.push(recovered);
      assert.equal((await recovered.callTool("echo", { value: "recovered" },
        { runId: "http-recovered" })).structuredContent.account, "account-a");
      await recovered.release();
      await pool.drainHttp(badHttp);
      const rotatedA = { ...httpA, authRevision: 2,
        credentialProvider: provider(() => tokenA, "account-a", 2) };
      await assert.rejects(pool.acquireHttp(rotatedA),
        (error) => error.code === "ACTIVATION_DEFERRED");
      await assert.rejects(first.callTool("echo", { value: "draining" }, { runId: "http-a" }),
        (error) => error.code === "PLUGIN_CONNECTION_CLOSED");
      await first.release();
      await shared.release();
      const renewed = await pool.acquireHttp(rotatedA);
      handles.push(renewed);
      assert.equal((await renewed.callTool("echo", { value: "renewed" }, { runId: "http-a" }))
        .structuredContent.account, "account-a");
      assert.equal(fixtureHttp.state.methods.filter((method) => method === "initialize").length, 4);
      assert.deepEqual(fixtureHttp.state.callAccounts,
        ["account-a", "account-a", "account-b", "account-a", "account-a"]);
      await renewed.release();
      await otherAccount.release();
      await pool.drainHttp(httpA);
      await pool.drainHttp(httpB);

      const httpDrainOptions = { ...httpA,
        installationId: "local-plugin-http-drain", connectionId: "connection-drain",
        executionScope: "drain-scope" };
      const heldHttp = await pool.acquireHttp(httpDrainOptions);
      await assert.rejects(pool.drainInstallation(httpDrainOptions.installationId),
        (error) => error.code === "ACTIVATION_DEFERRED");
      await assert.rejects(heldHttp.listTools(),
        (error) => error.code === "PLUGIN_CONNECTION_CLOSED");
      await assert.rejects(pool.acquireHttp(httpDrainOptions),
        (error) => error.code === "PLUGIN_COMPONENT_INACTIVE");
      await heldHttp.release();
      await pool.drainInstallation(httpDrainOptions.installationId);
      pool.resumeInstallation(httpDrainOptions.installationId);

      const shutdownStdio = await pool.acquireStdio(options);
      const shutdownHttp = await pool.acquireHttp(httpA);
      await pool.close();
      await assert.rejects(shutdownStdio.callTool("echo", { value: "closed" },
        { runId: "after-close" }), (error) => error.code === "PLUGIN_CONNECTION_CLOSED");
      await assert.rejects(shutdownHttp.listTools(),
        (error) => error.code === "PLUGIN_CONNECTION_CLOSED");
      await assert.rejects(pool.acquireStdio(options),
        (error) => error.code === "PLUGIN_CONNECTION_CLOSED");
      await shutdownStdio.release();
      await shutdownHttp.release();
      pool.open();
      const reopenedStdio = await pool.acquireStdio(options);
      assert.equal((await reopenedStdio.callTool("echo", { value: "new-generation" },
        { runId: "after-reopen" })).structuredContent.echoed, "new-generation");
      await reopenedStdio.release();
      await pool.close();
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.release()));
      await Promise.allSettled([pool.drainHttp(httpA), pool.drainHttp(httpB),
        pool.drainHttp({ ...httpA, connectionId: "connection-bad" })]);
      await fixtureHttp.close();
    }
    console.log("plugin MCP connection pool: PASS");
  } finally {
    await Promise.allSettled([pool.drainScope({ installationId, scopeId }),
      pool.drainScope({ installationId, scopeId: "d".repeat(64) })]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
