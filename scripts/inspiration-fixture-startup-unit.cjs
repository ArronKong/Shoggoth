"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const server = require("../app/agent-service/server");

// Capture only the real Service created by this fixture so the pre-fix failure
// can also be cleaned up by the test, without leaving a listening process.
const created = [];
let fault;
const create = server.createAgentService;
server.createAgentService = (options) => {
  const service = create(options);
  const controller = service.agentLifecycleServiceController;
  const handle = controller.handle, close = controller.close, current = fault;
  controller.handle = async function(method, params) {
    if (method !== "agent.create") return handle.call(this, method, params);
    current.requests++;
    if (current.mode === "rejected") throw Object.assign(new Error("Fixture initialization rejected"), { code: "AGENT_INITIALIZATION_FAILED" });
    const result = await handle.call(this, method, params);
    await new Promise(resolve => setTimeout(resolve, 2100));
    return result;
  };
  controller.close = function() { current.closeCount++; return close.call(this); };
  created.push({ service, root: options.paths.trustedRoot });
  return service;
};
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
server.createAgentService = create;

for (const mode of ["timeout", "rejected"]) {
  test(`fixture startup ${mode} preserves the error and closes its real Service`, async () => {
    const start = created.length;
    fault = { mode, closeCount: 0, requests: 0 };
    try {
      await assert.rejects(startInspirationFixture({ isolatedHome: true, agentCount: 2,
        serviceOptions: { prewarmMcpAuth: false } }), error => {
        assert.equal(error.fixtureMethod, "agent.create");
        assert.equal(error.code, mode === "timeout" ? "REQUEST_TIMEOUT" : "AGENT_INITIALIZATION_FAILED");
        if (mode === "timeout") {
          assert.equal(error.serviceRequestDiagnostic.timeoutMs, 2000, "keep the original control-request deadline");
          assert.equal(error.serviceRequestDiagnostic.phase, "response");
        }
        return true;
      });
      assert.equal(created.length, start + 1);
      assert.equal(fault.requests, 1, "an unknown creation result is never replayed");
      assert.equal(fault.closeCount, 1, "startup failure closes the Service before rejecting");
      assert.equal(fs.existsSync(created[start].root), false, "only the disposable fixture root is removed after shutdown");
    } finally {
      for (const { service, root } of created.slice(start)) {
        await service.stop();
        assert.match(require("node:path").basename(root), /^shg-insp-/u);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
}
