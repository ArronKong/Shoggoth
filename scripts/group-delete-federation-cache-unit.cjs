#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { FederationHostClient } = require("../app/agent-service/federation-host-client");
const { createFederationHostServer } = require("../app/federation-host-server");

async function fixture(t, cancel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-delete-cache-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const params = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), backendId: "hermes",
    agentId: "helper", sessionKey: "agent:helper:group-original", workspace: "/fixture", mode: "gateway",
    hostId: crypto.randomUUID(), operationId: "delete-group-original", stopGroup: true };
  const snapshot = { executionId: params.executionId, runId: params.runId, backendId: params.backendId,
    agentId: params.agentId, sessionKey: params.sessionKey, workspace: params.workspace, mode: params.mode,
    status: "completed", sequence: 3, resultSummary: null, errorCode: null, finishedAt: 1, attention: null };
  const calls = [];
  const unused = () => assert.fail("deletion must never prepare, start or respond to a model turn");
  const host = createFederationHostServer({ paths,
    registry: { async getStatus() { return []; }, getBackend: unused },
    groupRunner: { prepare: unused, start: unused, get: unused, respond: unused, reset() {},
      async cancel(input) { calls.push(structuredClone(input)); return cancel(calls.length, snapshot, params); } } });
  t.after(async () => { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await host.start();
  return { params, calls, client: new FederationHostClient({ paths, timeoutMs: 2000 }) };
}

test("group deletion retries an unfinished whole-Host stop even when the selected execution is already terminal", async t => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (count, snapshot, params) => {
    if (count === 1) await first;
    return { hostId: params.hostId, snapshot, groupStopped: count > 1 };
  });
  const pending = [f.client.request("group.external.cancel", f.params), f.client.request("group.external.cancel", f.params)];
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.client.request("backend.status", {});
  release();
  assert.deepEqual((await Promise.all(pending)).map(result => result.groupStopped), [false, false]);
  assert.equal(f.calls.length, 1, "concurrent requests share the in-flight cancellation");
  await assert.rejects(f.client.request("group.external.cancel", { ...f.params, runId: crypto.randomUUID() }),
    error => error.code === "FEDERATION_OPERATION_CONFLICT");
  assert.equal((await f.client.request("group.external.cancel", f.params)).groupStopped, true);
  assert.equal(f.calls.length, 2, "the same operation must recheck the whole Host after an unfinished receipt");
  assert.deepEqual(f.calls[1], f.calls[0], "reconciliation preserves the complete original execution identity");
  assert.equal((await f.client.request("group.external.cancel", f.params)).groupStopped, true);
  assert.equal(f.calls.length, 2, "a confirmed stop remains idempotent");
});

test("an unavailable group Host does not permanently cache a failed deletion confirmation", async t => {
  const f = await fixture(t, (count, snapshot, params) => {
    if (count === 1) throw Object.assign(new Error("not ready"), { code: "GROUP_HOST_IDENTITY_MISMATCH" });
    return { hostId: params.hostId, snapshot, groupStopped: true };
  });
  await assert.rejects(f.client.request("group.external.cancel", f.params),
    error => error.code === "GROUP_HOST_IDENTITY_MISMATCH");
  await assert.rejects(f.client.request("group.external.cancel", { ...f.params, sessionKey: "another-session" }),
    error => error.code === "FEDERATION_OPERATION_CONFLICT");
  assert.equal((await f.client.request("group.external.cancel", f.params)).groupStopped, true);
  assert.equal(f.calls.length, 2);
});
