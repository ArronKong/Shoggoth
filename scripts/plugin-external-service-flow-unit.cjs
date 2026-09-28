"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { createAgentService } = require("../app/agent-service/server");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgextsvc-")));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  let service;
  const request = (method, params) => requestService(paths, {
    version: SERVICE_PROTOCOL_VERSION, method, params,
  }, { timeoutMs: 10_000 });
  const identity = { backendId: "openclaw", instanceId: crypto.randomUUID(),
    agentId: "fixture-agent", sessionId: "fixture-session", runId: "fixture-run",
    toolCallId: "fixture-call" };
  try {
    const token = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false,
      externalPluginAgentVerifier: async row => ({ id: row.agentId, backendId: row.backendId }),
      version: "plugin-external-service-fixture" });
    await service.start();
    const auditQuery = { backendId: null, cursor: null, limit: 5 };
    await assert.rejects(request("plugins.external.calls.list", auditQuery),
      error => error.code === "AUTH_FAILED");
    await assert.rejects(requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.external.calls.list",
      token, params: auditQuery,
    }), error => error.code === "AUTH_FAILED");
    const authenticatedAudit = await requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.external.calls.list",
      token: readClientToken(paths), params: auditQuery,
    });
    assert.deepEqual(authenticatedAudit, { items: [], nextCursor: null });
    const scopedAudit = { backendId: "openclaw", agentId: identity.agentId,
      sessionId: identity.sessionId, toolCallId: identity.toolCallId,
      cursor: null, limit: 1 };
    assert.deepEqual(await requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.external.calls.list",
      token: readClientToken(paths), params: scopedAudit,
    }), { items: [], nextCursor: null });
    await assert.rejects(requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.external.calls.list",
      token: readClientToken(paths), params: { ...scopedAudit, sessionId: null },
    }), error => error.code === "PLUGIN_REQUEST_INVALID");
    const approvalQuery = { backendId: null, cursor: null, limit: 2 };
    await assert.rejects(request("plugins.external.approvals.list", approvalQuery),
      error => error.code === "AUTH_FAILED");
    await assert.rejects(requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.external.approvals.list",
      token, params: approvalQuery,
    }), error => error.code === "AUTH_FAILED");
    assert.deepEqual(await requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.external.approvals.list",
      token: readClientToken(paths), params: approvalQuery,
    }), { items: [], nextCursor: null });
    const lease = await request("plugin.external.open", { credentialToken: token, identity });
    assert.equal(typeof lease.token, "string");
    const empty = await request("plugin.external.search", {
      token: lease.token, identity, query: "", cursor: 0, limit: 5,
    });
    assert.deepEqual({ items: empty.items, nextCursor: empty.nextCursor, total: empty.total },
      { items: [], nextCursor: null, total: 0 });
    assert.match(empty.revision, /^[a-f0-9]{64}$/u);
    const nextPageLease = await request("plugin.external.open", { credentialToken: token, identity });
    await assert.rejects(request("plugin.external.search", {
      token: nextPageLease.token, identity, query: "", cursor: 1, limit: 5,
      revision: "0".repeat(64),
    }), error => error.code === "CATALOG_REVISION_CHANGED");
    await assert.rejects(request("plugin.external.search", {
      token: lease.token, identity, query: "", cursor: 0, limit: 5,
    }), error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    await assert.rejects(request("plugin.external.open", {
      credentialToken: ensureCredential(paths, "hermes"), identity,
    }), error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    await assert.rejects(request("plugin.external.open", {
      credentialToken: token, identity: { ...identity, extra: "model-supplied" },
    }), error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    const canceled = await request("plugin.external.open", { credentialToken: token,
      identity: { ...identity, toolCallId: "cancel-call" } });
    const cancelIdentity = { ...identity, toolCallId: "cancel-call" };
    assert.deepEqual(await request("plugin.external.cancel", {
      token: canceled.token, identity: cancelIdentity }), { canceled: true });
    await assert.rejects(request("plugin.external.search", {
      token: canceled.token, identity: cancelIdentity, query: "", cursor: 0, limit: 5,
    }), error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    const disconnectIdentity = { ...identity, toolCallId: "disconnect-call" };
    const pending = await request("plugin.external.open", {
      credentialToken: token, identity: disconnectIdentity });
    let enteredResolve;
    let releaseResolve;
    let canceledResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const held = new Promise(resolve => { releaseResolve = resolve; });
    const canceledSocket = new Promise(resolve => { canceledResolve = resolve; });
    const toolService = service.externalPluginToolService;
    const originalCall = toolService.call.bind(toolService);
    const originalCancel = toolService.cancel.bind(toolService);
    toolService.call = async params => {
      enteredResolve(params);
      await held;
      return originalCall(params);
    };
    toolService.cancel = params => {
      try {
        const result = originalCancel(params);
        canceledResolve({ params, error: null });
        return result;
      } catch (error) {
        canceledResolve({ params, error });
        throw error;
      } finally { releaseResolve(); }
    };
    const socket = net.createConnection(paths.socketPath);
    let disconnectTimer = null;
    try {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(`${JSON.stringify({ id: crypto.randomUUID(),
        version: SERVICE_PROTOCOL_VERSION, method: "plugin.external.call",
        params: { token: pending.token, identity: disconnectIdentity,
          serverId: "plugin.fixture", toolName: "blocked", arguments: {} } })}\n`);
      await entered;
      socket.destroy();
      const canceledCall = await Promise.race([canceledSocket,
        new Promise((_, reject) => { disconnectTimer = setTimeout(() => reject(new Error(
          "Service did not cancel a disconnected external call")), 2_000); })]);
      assert.equal(canceledCall.error, null);
      assert.deepEqual(canceledCall.params.identity, disconnectIdentity);
      await assert.rejects(request("plugin.external.search", {
        token: pending.token, identity: disconnectIdentity, query: "", cursor: 0, limit: 5,
      }), error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    } finally {
      socket.destroy();
      if (disconnectTimer) clearTimeout(disconnectTimer);
      releaseResolve();
      toolService.call = originalCall;
      toolService.cancel = originalCancel;
    }
    await service.stop();
    service = null;
    fs.writeFileSync(path.join(paths.pluginsDir, "external-provenance.sqlite"),
      "damaged derived audit projection");
    service = createAgentService({ paths, prewarmMcpAuth: false,
      externalPluginAgentVerifier: async row => ({ id: row.agentId, backendId: row.backendId }),
      version: "plugin-external-service-fixture" });
    await service.start();
    assert.equal((await requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method: "service.status",
      token: readClientToken(paths),
    })).healthy, true);
    await assert.rejects(requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.external.calls.list",
      token: readClientToken(paths), params: auditQuery,
    }), error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
    console.log("plugin-external-service-flow-unit: ok");
  } finally {
    if (service) await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
