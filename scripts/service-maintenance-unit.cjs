"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-q-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "data"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const service = createAgentService({ paths, parentEnv: {}, prewarmMcpAuth: false });
  const rpc = (method, params = {}) => requestService(paths, {
    token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
  }, { timeoutMs: 10_000 });
  try {
    await service.start();
    const status = await rpc("service.status");
    assert.equal(status.productSchemaVersion, 15);
    assert.equal(status.maintenanceQuiesced, false);
    const impact = await rpc("service.stopImpact");
    assert.equal(impact.totalCount, 0);
    await assert.rejects(rpc("service.quiesceIdle", { instanceNonce: "stale", revision: impact.revision }), { code: "INVALID_PARAMS" });
    await assert.rejects(rpc("service.quiesceIdle", { instanceNonce: status.instanceNonce, revision: "0".repeat(64) }), { code: "SERVICE_MAINTENANCE_BUSY" });
    assert.equal((await rpc("service.status")).maintenanceQuiesced, false);
    const listRuns = service.workRunCoordinator.listRuns.bind(service.workRunCoordinator);
    service.workRunCoordinator.listRuns = () => [{ id: "fixture-running", profileId: "fixture-profile",
      source: "chat", sourceId: "fixture-session", status: "running", waitingRequestId: null, runtimeTurnRef: null }];
    await assert.rejects(rpc("service.quiesceIdle", { instanceNonce: status.instanceNonce,
      revision: (await rpc("service.stopImpact")).revision }), { code: "SERVICE_MAINTENANCE_BUSY" });
    service.workRunCoordinator.listRuns = listRuns;
    service.workRunCoordinator.pendingSessionSends.set("fixture-session", 1);
    await assert.rejects(rpc("service.quiesceIdle", { instanceNonce: status.instanceNonce,
      revision: impact.revision }), { code: "SERVICE_MAINTENANCE_BUSY" });
    service.workRunCoordinator.pendingSessionSends.clear();
    assert.equal((await rpc("service.status")).maintenanceQuiesced, false);
    const fence = await rpc("service.quiesceIdle", { instanceNonce: status.instanceNonce, revision: impact.revision });
    assert.equal(fence.quiesced, true);
    assert.equal((await rpc("service.status")).maintenanceQuiesced, true);
    assert.equal((await rpc("service.stopImpact")).totalCount, 0);
    await assert.rejects(rpc("profile.list"), { code: "SERVICE_QUIESCED" });
    await assert.rejects(rpc("mcp.runtime.auth"), { code: "SERVICE_QUIESCED" });
    assert.throws(() => service.workRunCoordinator.quiesceIfIdle(), { code: "SERVICE_QUIESCED" });
    await service.stop({ notify: false });
    console.log("PASS Service atomic quiescence and identity fixture");
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
