"use strict";

const assert = require("node:assert/strict");
const {
  FORK_ATTACHMENT_MAX_BASE64_BYTES,
  advancedSessionMethodMap,
  projectEnvironmentInventory,
  projectSessionDescribeResult,
  projectSessionBranchesResult,
  projectSessionForkResult,
} = require("../app/core/session-advanced-projection");

const methods = advancedSessionMethodMap({
  "environments.list": true,
  "sessions.describe": true,
  "sessions.branches.list": true,
  "sessions.fork": true,
  "unknown.method": true,
});
assert.deepEqual(Object.keys(methods), [
  "environments.list",
  "sessions.describe",
  "sessions.branches.list",
  "sessions.fork",
]);

const inventory = projectEnvironmentInventory({
  environments: [{
    id: "worker-1",
    type: "worker",
    label: "Worker 1",
    status: "available",
    platform: "darwin",
    sessionHost: true,
    trust: "disposable",
    desktop: true,
    workerSlots: { total: 4, available: 2, secret: "slots-secret" },
    workerBundle: { status: "installed", version: "2026.8.1", hash: "bundle-secret" },
    capabilities: ["canvas", "desktop.stream", "node.shell"],
    invocableCommands: ["secret-command"],
    command: "secret-command-2",
    issues: [{ code: "update-required", action: "update-and-reconnect", updateCommand: "secret-command-3" }],
    worker: {
      providerId: "crabbox",
      leaseId: "secret-lease",
      state: "ready",
      ageMs: 12,
      idleMs: 3,
      tunnelStatus: "connected",
      desktop: true,
      desktopApps: ["browser", "terminal"],
      attachedSessionIds: ["secret-session-a", "secret-session-b"],
      error: "secret-worker-error",
    },
  }],
  profiles: [{
    id: "cloud",
    providerId: "crabbox",
    trust: "disposable",
    executionMode: "worker-turn",
    executionModes: ["worker-turn", "remote-exec"],
    machines: [{ id: "small", label: "Small", cpu: 4, memoryGb: 8, default: true, price: "secret" }],
    settings: { token: "profile-secret" },
  }],
}, methods);

assert.equal(inventory.supported, true);
assert.equal(inventory.environments[0].worker.attachedSessionCount, 2);
assert.deepEqual(inventory.environments[0].workerSlots, { total: 4, available: 2 });
assert.deepEqual(inventory.profiles[0].machines[0], {
  id: "small", label: "Small", cpu: 4, memoryGb: 8, default: true,
});
const inventoryJson = JSON.stringify(inventory);
for (const secret of [
  "secret-command", "secret-lease", "secret-session-a", "secret-worker-error",
  "bundle-secret", "profile-secret", "node.shell",
]) {
  assert.equal(inventoryJson.includes(secret), false, `environment projection leaked ${secret}`);
}

const described = projectSessionDescribeResult({
  session: {
    key: "agent:main:fork-1",
    agentId: "main",
    kind: "direct",
    label: "A session",
    displayName: "A session",
    derivedTitle: "Derived",
    lastMessagePreview: "hello",
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    status: "idle",
    model: "model",
    modelProvider: "provider",
    activeLeafEntryId: "leaf-1",
    parentSessionKey: "agent:main:main",
    forkSource: { sessionKey: "agent:main:main", entryId: "entry-1", sessionId: "secret-source-id" },
    placement: {
      state: "active",
      environmentId: "worker-1",
      providerId: "crabbox",
      profileId: "cloud",
      generation: 2,
      createdAtMs: 3,
      updatedAtMs: 4,
      stateChangedAtMs: 5,
      terminalReason: "none",
      terminalAtMs: 6,
      activeOwnerEpoch: "secret-owner",
      workspace: "/secret/workspace",
      recoveryError: "secret-recovery",
    },
    sessionId: "secret-session-id",
    cwd: "/secret/cwd",
  },
}, methods);
assert.equal(described.session.key, "agent:main:fork-1");
assert.equal(JSON.stringify(described).includes("secret-"), false);

const branches = projectSessionBranchesResult({
  branches: [{
    leafEntryId: "leaf-1",
    headline: "latest",
    messageCount: 7,
    updatedAt: "2026-08-31T00:00:00.000Z",
    active: true,
    command: "secret-command",
  }],
}, methods);
assert.deepEqual(branches.branches, [{
  leafEntryId: "leaf-1",
  headline: "latest",
  messageCount: 7,
  updatedAt: "2026-08-31T00:00:00.000Z",
  active: true,
}]);

const fullAttachment = "A".repeat(FORK_ATTACHMENT_MAX_BASE64_BYTES);
const forked = projectSessionForkResult({
  sessionKey: "agent:main:fork-2",
  editorText: "edit me",
  editorAttachments: Array.from({ length: 9 }, () => ({ mimeType: "image/png", data: fullAttachment })),
  internalToken: "secret-token",
}, methods);
assert.equal(forked.supported, true);
assert.equal(forked.sessionKey, "agent:main:fork-2");
assert.equal(forked.editorAttachments.length, 8, "64 MiB aggregate cap should keep eight 8 MiB entries");
assert.equal(forked.attachmentsOmitted, true);
assert.equal(JSON.stringify({ ...forked, editorAttachments: [] }).includes("secret-token"), false);

const invalidAttachment = projectSessionForkResult({
  sessionKey: "agent:main:fork-3",
  editorText: "keep\nmultiline\ntext",
  editorAttachments: [{ mimeType: "image/png\r\nX-Leak: yes", data: "not-base64" }],
}, methods);
assert.equal(invalidAttachment.supported, true, "a completed fork must not be discarded");
assert.equal(invalidAttachment.sessionKey, "agent:main:fork-3");
assert.equal(invalidAttachment.editorText, "keep\nmultiline\ntext");
assert.equal(invalidAttachment.editorAttachments, undefined);
assert.equal(invalidAttachment.attachmentsOmitted, true);

console.log("session advanced projection: PASS");
