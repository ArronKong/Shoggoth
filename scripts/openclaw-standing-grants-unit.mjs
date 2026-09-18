import assert from "node:assert/strict";
import backendModule from "../app/core/openclaw-backend.js";
import staticServerModule from "../app/static-server.js";

const { OpenClawBackend } = backendModule;
const { startStaticServer } = staticServerModule;

function negotiated(methods) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.8.1", connId: "connection" },
    features: { methods, events: [] },
    auth: { role: "operator", scopes: ["operator.approvals"] },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 },
  };
}

{
  const backend = new OpenClawBackend();
  backend._acceptGatewayHello(negotiated([
    "exec.approval.grants.list",
    "exec.approval.grants.revoke",
  ]));
  backend._connect = async () => {};
  const calls = [];
  backend.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "exec.approval.grants.list") {
      return {
        grants: [{
          grantId: "grant-1",
          mintedByApprovalId: "approval-1",
          agentId: "main",
          cronJobId: "cron-1",
          cronJobName: "nightly",
          command: "npm test",
          cwd: "/workspace",
          rawSecret: "must-not-cross-rest-boundary",
          createdAtMs: 1,
          expiresAtMs: 2,
          revokedAtMs: null,
          revokedBy: null,
          lastUsedAtMs: null,
          useCount: 0,
        }, {
          command: "invalid rows must be dropped",
          rawSecret: "must-not-cross-rest-boundary",
        }],
      };
    }
    return {
      outcome: "revoked",
      grant: { command: "must-not-cross-rest-boundary" },
      rawSecret: "must-not-cross-rest-boundary",
    };
  };
  const list = await backend.listStandingGrants({ limit: 20 });
  assert.equal(list.supported, true);
  assert.equal(list.grants.length, 1);
  assert.deepEqual(list.grants[0], {
    backendId: "openclaw",
    grantId: "grant-1",
    mintedByApprovalId: "approval-1",
    agentId: "main",
    cronJobId: "cron-1",
    cronJobName: "nightly",
    createdAtMs: 1,
    expiresAtMs: 2,
    revokedAtMs: null,
    revokedBy: null,
    lastUsedAtMs: null,
    useCount: 0,
  });
  assert.equal("command" in list.grants[0], false);
  assert.equal("cwd" in list.grants[0], false);
  assert.equal("rawSecret" in list.grants[0], false);
  assert.deepEqual(await backend.revokeStandingGrant("grant-1"), { outcome: "revoked" });
  assert.deepEqual(calls, [
    { method: "exec.approval.grants.list", params: { limit: 20 } },
    { method: "exec.approval.grants.revoke", params: { grantId: "grant-1" } },
  ]);
}

{
  const backend = new OpenClawBackend();
  backend._acceptGatewayHello(negotiated([]));
  backend._connect = async () => {};
  backend.request = async () => {
    throw new Error("must not request an unadvertised method");
  };
  assert.deepEqual(await backend.listStandingGrants(), {
    supported: false,
    reason: "gateway-method-unavailable",
    grants: [],
  });
}

{
  const backend = new OpenClawBackend();
  backend._acceptGatewayHello(negotiated(["exec.approval.grants.revoke"]));
  backend._connect = async () => {};
  backend.request = async () => ({ outcome: "unexpected", rawSecret: "must-not-leak" });
  await assert.rejects(
    backend.revokeStandingGrant("grant-1"),
    /standing grant revoke returned an invalid response/,
  );
}

{
  const calls = [];
  const server = await startStaticServer(0, {
    registry: {
      async listStandingGrants(backendId, options) {
        calls.push({ method: "list", backendId, options });
        return {
          supported: true,
          grants: [{
            backendId: "spoofed",
            grantId: "grant/with/slash",
            mintedByApprovalId: "approval-2",
            agentId: "main",
            cronJobId: "cron-2",
            cronJobName: "nightly",
            command: "printenv SECRET",
            cwd: "/sensitive/workspace",
            rawSecret: "must-not-cross-rest-boundary",
            createdAtMs: 10,
            expiresAtMs: null,
            revokedAtMs: null,
            revokedBy: null,
            lastUsedAtMs: 20,
            useCount: 3,
          }, {
            command: "invalid rows must be dropped",
            rawSecret: "must-not-cross-rest-boundary",
          }],
        };
      },
      async revokeStandingGrant(backendId, grantId) {
        calls.push({ method: "revoke", backendId, grantId });
        return {
          supported: true,
          outcome: "revoked",
          grantId,
          command: "must-not-cross-rest-boundary",
          rawSecret: "must-not-cross-rest-boundary",
        };
      },
    },
  });
  try {
    const listed = await fetch(`${server.url}/__api/approval-grants?backend=openclaw&limit=999`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), {
      supported: true,
      grants: [{
        backendId: "openclaw",
        grantId: "grant/with/slash",
        mintedByApprovalId: "approval-2",
        agentId: "main",
        cronJobId: "cron-2",
        cronJobName: "nightly",
        createdAtMs: 10,
        expiresAtMs: null,
        revokedAtMs: null,
        revokedBy: null,
        lastUsedAtMs: 20,
        useCount: 3,
      }],
    });

    const revoked = await fetch(
      `${server.url}/__api/approval-grants?backend=openclaw&id=${encodeURIComponent("grant/with/slash")}`,
      { method: "DELETE" },
    );
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { supported: true, outcome: "revoked" });
    assert.deepEqual(calls, [
      { method: "list", backendId: "openclaw", options: { limit: 500 } },
      { method: "revoke", backendId: "openclaw", grantId: "grant/with/slash" },
    ]);
  } finally {
    await server.close();
  }
}

{
  const server = await startStaticServer(0, {
    registry: {
      async listStandingGrants() {
        return { supported: false, reason: "unsupported", grants: [{ command: "must-not-leak" }] };
      },
    },
  });
  try {
    const response = await fetch(`${server.url}/__api/approval-grants?backend=openclaw`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { supported: false, reason: "unsupported", grants: [] });
  } finally {
    await server.close();
  }
}

console.log("openclaw standing grants: PASS");
