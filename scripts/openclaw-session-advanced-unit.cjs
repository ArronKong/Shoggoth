"use strict";

const assert = require("node:assert/strict");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

const methodNames = [
  "environments.list",
  "sessions.describe",
  "sessions.branches.list",
  "sessions.fork",
];

function hello({ methods = methodNames, scopes = ["operator.read", "operator.write"] } = {}) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.8.1" },
    features: { methods, events: [], capabilities: [] },
    auth: { role: "operator", scopes },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 },
  };
}

async function main() {
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  backend._acceptGatewayHello(hello());
  const calls = [];
  backend.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "environments.list") {
      return {
        environments: [{
          id: "gateway", type: "local", status: "available", sessionHost: true,
          invocableCommands: ["secret-command"],
        }],
      };
    }
    if (method === "sessions.describe") {
      return {
        session: {
          key: params.key,
          agentId: "main",
          derivedTitle: "Session",
          sessionId: "secret-session-id",
        },
      };
    }
    if (method === "sessions.branches.list") {
      return {
        branches: [{ leafEntryId: "leaf-1", headline: "Latest", messageCount: 3, active: true }],
      };
    }
    if (method === "sessions.fork") {
      return {
        sessionKey: "agent:main:fork-1",
        editorText: "edit",
        editorAttachments: [{ mimeType: "image/png", data: "QUJDRA==" }],
      };
    }
    throw new Error("unexpected method");
  };

  const inventory = await backend.listEnvironments();
  assert.equal(inventory.supported, true);
  assert.equal(inventory.methods["sessions.fork"], true);
  assert.equal(JSON.stringify(inventory).includes("secret-command"), false);

  const description = await backend.describeSession("main", "agent:main:main");
  assert.equal(description.session.derivedTitle, "Session");
  assert.equal(JSON.stringify(description).includes("secret-session-id"), false);
  assert.deepEqual(calls.find((call) => call.method === "sessions.describe").params, {
    key: "agent:main:main",
    includeDerivedTitles: true,
    includeLastMessage: true,
  });

  const branches = await backend.listSessionBranches("main", "agent:main:main");
  assert.equal(branches.branches[0].leafEntryId, "leaf-1");
  assert.deepEqual(calls.find((call) => call.method === "sessions.branches.list").params, {
    sessionKey: "agent:main:main",
    agentId: "main",
  });

  const fork = await backend.forkSessionAtEntry("main", "agent:main:main", "entry-1");
  assert.equal(fork.sessionKey, "agent:main:fork-1");
  assert.deepEqual(calls.find((call) => call.method === "sessions.fork").params, {
    sessionKey: "agent:main:main",
    agentId: "main",
    entryId: "entry-1",
  });

  const callsBeforeOwnerMismatch = calls.length;
  const mismatchedDescription = await backend.describeSession("main", "agent:other:main");
  const mismatchedBranches = await backend.listSessionBranches("main", "agent:other:main");
  const mismatchedFork = await backend.forkSessionAtEntry("main", "agent:other:main", "entry-1");
  for (const result of [mismatchedDescription, mismatchedBranches, mismatchedFork]) {
    assert.equal(result.supported, false);
    assert.equal(result.reason, "invalid-request");
  }
  assert.equal(calls.length, callsBeforeOwnerMismatch,
    "a session key owned by another agent must be rejected before any Gateway RPC");

  backend._acceptGatewayHello(hello({ scopes: ["operator.read"] }));
  let calledWithoutWrite = false;
  backend.request = async () => {
    calledWithoutWrite = true;
    return {};
  };
  const unavailableFork = await backend.forkSessionAtEntry("main", "agent:main:main", "entry-1");
  assert.equal(unavailableFork.supported, false);
  assert.equal(unavailableFork.methods["sessions.fork"], false);
  assert.equal(calledWithoutWrite, false, "scope check must happen before the write RPC");

  backend._acceptGatewayHello(hello({ scopes: ["operator.write"] }));
  backend.request = async () => ({ environments: [] });
  const writeImpliesRead = await backend.listEnvironments();
  assert.equal(writeImpliesRead.methods["environments.list"], true);

  backend._acceptGatewayHello(hello({ methods: ["sessions.describe"], scopes: ["operator.admin"] }));
  backend.request = async () => { throw new Error("raw upstream secret"); };
  const failedDescription = await backend.describeSession("main", "agent:main:main");
  assert.equal(failedDescription.supported, false);
  assert.equal(failedDescription.reason, "error");
  assert.equal(failedDescription.methods["sessions.describe"], true);
  assert.equal(JSON.stringify(failedDescription).includes("raw upstream secret"), false);

  const missingBranches = await backend.listSessionBranches("main", "agent:main:main");
  assert.equal(missingBranches.supported, false);
  assert.equal(missingBranches.reason, "unsupported");
  assert.equal(missingBranches.methods["sessions.branches.list"], false);

  console.log("openclaw session advanced: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
