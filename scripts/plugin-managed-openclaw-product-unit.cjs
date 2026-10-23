#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { createManagedOpenClawProductHost, projectManagedOpenClawHostStatus } = require("../app/managed-openclaw-product-host");
function fixture({ healthy = true, waiting = false, closeFails = false } = {}) {
  let mode = "existing", state = "absent", enabled = true, candidate = null, copies = 0, activations = 0, stops = 0, clients = 0, unavailable = 0, ready = 0;
  let release;
  const endpoint = { url: "ws://127.0.0.1:9", token: "private-secret", dataRoot: "/private/test" };
  const execution = { home: "/private/test/home", configPath: "/private/test/config" };
  const client = {
    ready: waiting ? new Promise(resolve => { release = resolve; }) : Promise.resolve(),
    getStatus: () => ({ state, ownership: state === "running" ? "managed" : "absent", selectionSupported: true,
      dataRoot: "/private/test", token: "must-never-be-public" }),
    getEndpoint: () => state === "running" ? endpoint : null,
    getExecution: () => state === "running" ? execution : null,
    controller: {
      getCandidate: async input => { assert.deepEqual(input, {}); return candidate; },
      prepareCandidate: async input => { assert.deepEqual(input, {}); copies += 1; return candidate = { candidateId: "a".repeat(64) }; },
      activateCandidate: async input => { assert.equal(input.candidateId, candidate.candidateId); activations += 1;
        state = "running"; return { healthVerified: healthy }; },
      stopOwned: async input => { assert.equal(input.timeoutMs, 60000); stops += 1; state = "absent"; },
    },
    close: async () => { stops += 1; if (closeFails) { closeFails = false;
      throw Object.assign(new Error("owned stop timed out"), { code: "MANAGED_HOST_STOP_TIMEOUT" }); }
      state = "closed"; },
  };
  const host = createManagedOpenClawProductHost({ getMode: () => mode, setManagedMode: () => { mode = "managed"; },
    createClient: () => { clients += 1; state = "absent"; return client; }, getEnabled: () => enabled,
    onUnavailable: async () => { unavailable += 1; }, onReady: async () => { ready += 1; } });
  return { host, client, release: () => release?.(), disconnect: () => { state = "unknown_writer"; }, setEnabled: value => { enabled = value; },
    counts: () => ({ copies, activations, stops, clients, unavailable, ready }) };
}
async function main() {
  const f = fixture();
  assert.equal(f.host.getExecution(), undefined);
  assert.equal(f.counts().clients, 0);
  for (const invalid of [null, {}, { operationId: "bad/id" }, { operationId: "ok", sourceRoot: "/user" },
    { operationId: "ok", token: "secret" }, { operationId: "ok", authority: {} }, { operationId: "ok", policy: {} }]) {
    assert.throws(() => f.host.prepare(invalid), { code: "MANAGED_HOST_OPERATION_INVALID" });
  }
  assert.equal(f.counts().clients, 0);
  console.log("PASS existing mode is lazy; web requests cannot choose runtime paths, credentials or authority");
  assert.equal(f.host.prepare({ operationId: "prepare-one" }).state, "preparing");
  assert.equal(f.host.getExecution(), null);
  assert.equal(f.host.getEndpoint(), null);
  assert.equal(f.host.prepare({ operationId: "prepare-one" }).operationId, "prepare-one");
  assert.throws(() => f.host.restart({ operationId: "different" }), { code: "MANAGED_HOST_OPERATION_BUSY" });
  assert.throws(() => f.host.stop({ operationId: "prepare-one" }), { code: "MANAGED_HOST_OPERATION_CONFLICT" });
  assert.equal((await f.host.waitForOperation("prepare-one")).state, "running");
  assert.equal(f.host.getExecution().home, "/private/test/home");
  assert.equal(f.host.getStatus().selectionSupported, true);
  assert.equal(f.counts().copies, 1); assert.equal(f.counts().activations, 1);
  console.log("PASS one immutable preparation/activation; duplicates observe and unavailable managed mode never falls back");
  f.host.restart({ operationId: "restart-one" }); await f.host.waitForOperation("restart-one");
  assert.equal(f.counts().copies, 1); assert.equal(f.counts().activations, 2);
  assert.equal(f.counts().ready, 2);
  f.host.prepare({ operationId: "prepare-one" });
  assert.equal(f.counts().activations, 2);
  assert.equal(f.host.getOperationStatus("prepare-one").operationId, "prepare-one");
  assert.equal(f.host.getOperationStatus("prepare-one").selectionSupported, false);
  assert.equal(f.host.getOperationStatus("restart-one").selectionSupported, true);
  assert.throws(() => f.host.getOperationStatus("missing"), { code: "MANAGED_HOST_OPERATION_NOT_FOUND" });
  assert.throws(() => f.host.getOperationStatus("bad/id"), { code: "MANAGED_HOST_OPERATION_INVALID" });
  console.log("PASS restart reuses the verified candidate; original operation replay never restarts");
  const publicStatus = f.host.getStatus();
  assert.deepEqual(Object.keys(publicStatus).sort(), ["version", "backendId", "mode", "state", "operationId", "selectionSupported", "errorCode"].sort());
  assert(!JSON.stringify(publicStatus).includes("private"));
  assert.equal(projectManagedOpenClawHostStatus({ state: "running", selectionSupported: "true", token: "secret" }).selectionSupported, false);
  assert.equal(projectManagedOpenClawHostStatus({ errorCode: "secret-token=value" }).errorCode, "MANAGED_HOST_ACTION_FAILED");
  console.log("PASS exact public status strips private endpoint, paths, identity and credentials");
  f.disconnect(); assert.equal(f.host.getStatus().state, "needs_verification");
  assert.equal(f.host.getEndpoint(), null); assert.equal(f.host.getExecution(), null);
  assert.equal(f.counts().clients, 1);
  console.log("PASS lost ownership clears readiness; no automatic replacement worker or legacy fallback");
  const bad = fixture({ healthy: "true" });
  bad.host.prepare({ operationId: "bad-health" });
  assert.equal((await bad.host.waitForOperation("bad-health")).state, "needs_verification");
  assert.equal(bad.counts().ready, 0); assert.equal(bad.host.getEndpoint(), null);
  assert.equal(bad.host.getExecution(), null);
  console.log("PASS only a strict successful health receipt opens the product endpoint");
  await f.host.close(); assert.equal(f.host.getStatus().state, "stopped");
  assert.equal(f.host.getExecution(), null);
  assert.throws(() => f.host.prepare({ operationId: "after-close" }), { code: "MANAGED_HOST_CLOSING" });
  console.log("PASS closing uses owned-stop client and prohibits late activation");
  const retry = fixture({ closeFails: true });
  retry.host.prepare({ operationId: "prepare-close-retry" }); await retry.host.waitForOperation("prepare-close-retry");
  await assert.rejects(retry.host.close(), { code: "MANAGED_HOST_STOP_TIMEOUT" });
  assert.equal(retry.host.getStatus().state, "needs_verification"); assert.equal(retry.host.getEndpoint(), null);
  assert.throws(() => retry.host.prepare({ operationId: "replace-after-failed-close" }), { code: "MANAGED_HOST_CLOSING" });
  retry.host.stop({ operationId: "explicit-stop-retry" });
  assert.equal((await retry.host.waitForOperation("explicit-stop-retry")).state, "stopped");
  assert.equal(retry.counts().clients, 1); assert.equal(retry.counts().activations, 1);
  const untouched = fixture();
  untouched.host.prepare({ operationId: "prepare-close-before-worker" }); await untouched.host.close();
  assert.equal(untouched.counts().clients, 0); assert.equal(untouched.host.getStatus().state, "stopped");
  console.log("PASS failed close remains non-ready; explicit stop reuses the original client; pre-client cancellation starts no worker");
  const disable = fixture();
  disable.host.prepare({ operationId: "before-disable" }); await disable.host.waitForOperation("before-disable");
  disable.setEnabled(false); assert.equal(disable.host.getEndpoint(), null);
  assert.throws(() => disable.host.prepare({ operationId: "start-while-disabled" }), { code: "MANAGED_HOST_BACKEND_DISABLED" });
  await disable.host.suspend({ operationId: "owned-disable" }); assert.equal(disable.host.getStatus().state, "stopped");
  assert.equal(disable.counts().clients, 1);
  disable.setEnabled(true); disable.host.prepare({ operationId: "explicit-enable" }); await disable.host.waitForOperation("explicit-enable");
  assert.equal(disable.host.getStatus().state, "running"); assert.equal(disable.counts().clients, 2);
  const unknown = fixture({ closeFails: true });
  unknown.host.prepare({ operationId: "before-unknown-disable" }); await unknown.host.waitForOperation("before-unknown-disable");
  unknown.setEnabled(false); await assert.rejects(unknown.host.suspend());
  unknown.setEnabled(true); assert.throws(() => unknown.host.prepare({ operationId: "unsafe-reenable" }), { code: "MANAGED_HOST_CLOSING" });
  assert.equal(unknown.counts().clients, 1);
  unknown.host.stop({ operationId: "verify-original-disable" }); await unknown.host.waitForOperation("verify-original-disable");
  unknown.host.prepare({ operationId: "verified-reenable" }); await unknown.host.waitForOperation("verified-reenable");
  assert.equal(unknown.counts().clients, 2);
  console.log("PASS disable clears readiness immediately; only verified original owned exit permits explicit re-enable with a fresh client");
  console.log(JSON.stringify({ ok: true, groups: 9, modelCalls: 0, remoteCalls: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
