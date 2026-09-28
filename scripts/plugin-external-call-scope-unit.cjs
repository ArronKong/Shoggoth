"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ExternalPluginProvenance } = require("../app/agent-service/external-plugin-provenance");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-call-scope-")));
const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
  cacheRoot: path.join(root, "cache"), trustedRoot: root });
const store = { getCapabilityCall: () => null };
const provenance = new ExternalPluginProvenance({ paths, store }).open();

function add(callId, backendId, agentId, sessionId, toolCallId) {
  const identity = backendId === "openclaw"
    ? { backendId, instanceId: "fixture-instance", agentId, sessionId,
      runId: `run-${callId}`, toolCallId }
    : { backendId, instanceId: "fixture-instance", agentId, sessionId,
      taskId: `task-${callId}`, turnId: `turn-${callId}`, toolCallId };
  provenance.begin({ callId, identity, bindingId: "fixture-binding",
    installationId: "fixture-installation", componentId: "a".repeat(64),
    connectionId: "fixture-connection",
    toolIdentity: `plugin:fixture-binding:${"a".repeat(64)}:echo:${"b".repeat(64)}`,
    toolName: "echo", approvalRequired: true });
}

try {
  add("call-target", "openclaw", "agent-one", "session-one", "tool-one");
  add("call-other-agent", "openclaw", "agent-two", "session-one", "tool-one");
  add("call-other-session", "openclaw", "agent-one", "session-two", "tool-one");
  add("call-other-host", "hermes", "agent-one", "session-one", "tool-one");
  const target = { backendId: "openclaw", agentId: "agent-one",
    sessionId: "session-one", toolCallId: "tool-one", limit: 1 };
  assert.deepEqual(provenance.list(target).items.map(row => row.callId), ["call-target"]);
  assert.equal(provenance.list(target).nextCursor, null);
  assert.deepEqual(provenance.list({ ...target, sessionId: "missing" }).items, []);
  assert.deepEqual(provenance.list({ ...target, toolCallId: "missing" }).items, []);
  for (const query of [{ ...target, backendId: null }, { ...target, agentId: null },
    { ...target, sessionId: null }, { ...target, toolCallId: null },
    { ...target, toolCallId: "bad/slash" }]) {
    assert.throws(() => provenance.list(query), error => error.code === "PLUGIN_REQUEST_INVALID");
  }
  add("call-reused-tool-id", "openclaw", "agent-one", "session-one", "tool-one");
  const duplicate = provenance.list(target);
  assert.equal(duplicate.items.length, 1);
  assert(duplicate.nextCursor, "a repeated host toolCallId must be marked ambiguous");
  console.log("plugin-external-call-scope-unit: host/agent/session/call scope and duplicate ambiguity passed");
} finally {
  provenance.close();
  fs.rmSync(root, { recursive: true, force: true });
}
