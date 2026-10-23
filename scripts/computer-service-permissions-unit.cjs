"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-cu-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "data"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  let granted = false, requests = 0, reads = 0, invalid = false;
  const computerUseController = {
    open: async () => {}, close: async () => {}, pauseAll() {}, list: () => [], closeForProfile: async () => {},
    status: async (profileId) => {
      assert.equal(profileId, undefined, "global settings do not choose a Profile"); reads += 1;
      return { available: true, driverVersion: "0.22.0", contractVersion: "0.7.0",
        permissions: invalid ? {} : { accessibility: granted, screenRecording: granted }, sessions: [] };
    },
    requestPermissions: async () => { requests += 1; granted = true; return { accessibility: true, screenRecording: true }; },
  };
  for (const method of ["create", "resume", "closeSession", "applicationList", "windowList", "snapshot", "focus", "action"]) {
    computerUseController[method] = () => { throw new Error("settings must not create a desktop session or action"); };
  }
  const service = createAgentService({ paths, parentEnv: {}, prewarmMcpAuth: false, computerUseController });
  const rpc = (method, params = {}, token = readClientToken(paths)) => requestService(paths,
    { token, version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 10_000 });
  try {
    await service.start();
    await assert.rejects(rpc("computer.permissions.request", {}, "untrusted"), { code: "AUTH_FAILED" });
    await assert.rejects(rpc("computer.permissions.request", { profileId: "arbitrary" }), { code: "INVALID_PARAMS" });
    assert.equal(requests, 0);
    assert.deepEqual((await rpc("computer.status")).permissions, { accessibility: false, screenRecording: false });
    assert.equal(requests, 0, "status must not open a permission prompt");
    assert.deepEqual(await rpc("computer.permissions.request"), { accessibility: true, screenRecording: true });
    assert.deepEqual((await rpc("computer.status")).permissions, { accessibility: true, screenRecording: true });
    assert.equal(requests, 1);
    invalid = true;
    await assert.rejects(rpc("computer.status"), { code: "COMPUTER_PERMISSION_STATUS_FAILED" });
    assert.equal(reads, 3);
    console.log("Computer Service permissions: PASS (authenticated IPC, global scope, prompt-free status, invalid status refusal)");
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
