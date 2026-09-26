#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  normalizePluginSelection, resolvePluginSelection,
} = require("../app/agent-service/plugin-chat-selection");
const { validateChatServiceParams } = require("../app/agent-service/chat-service-protocol");

const a = { installationId: "plugin-a", revision: 2 };
const b = { installationId: "plugin-b", revision: 4 };
assert.deepEqual(normalizePluginSelection([b, a]), [a, b]);
for (const invalid of [[], [a, a], [a, b, a], [{ ...a, revision: 0 }],
  [{ ...a, packageName: "untrusted" }], [{ installationId: "../other", revision: 1 }]]) {
  assert.throws(() => normalizePluginSelection(invalid), { code: "PLUGIN_SELECTION_INVALID" });
}

let installation = { ...a, sourceIdentity: "bundled:plugin-a", releaseDigest: "a".repeat(64),
  desiredState: "enabled" };
let pendingDisable = false;
const store = {
  getInstallation(id) { return id === a.installationId ? installation : null; },
  getRelease() { return { name: "Package A", declaredVersion: "1.2.3",
    components: { skills: [{ name: "do-work" }], mcpServers: [] } }; },
  hasPendingInstallationDisable() { return pendingDisable; },
};
assert.deepEqual(resolvePluginSelection(store, [a]), [{ ...a,
  releaseDigest: installation.releaseDigest, packageName: "Package A", declaredVersion: "1.2.3" }]);
pendingDisable = true;
assert.throws(() => resolvePluginSelection(store, [a]), { code: "PLUGIN_SELECTION_STALE" });
pendingDisable = false;
installation = { ...installation, revision: 3 };
assert.throws(() => resolvePluginSelection(store, [a]), { code: "PLUGIN_SELECTION_STALE" });
installation = { ...installation, revision: 2, desiredState: "disabled" };
assert.throws(() => resolvePluginSelection(store, [a]), { code: "PLUGIN_SELECTION_STALE" });

installation = { ...installation, desiredState: "enabled" };
store.getRelease = () => ({ name: "MCP only", declaredVersion: "1.0",
  components: { skills: [], mcpServers: [{ name: "remote" }] } });
assert.throws(() => resolvePluginSelection(store, [a]), error =>
  error.code === "PLUGIN_SELECTION_UNAVAILABLE"
  && error.message.includes("尚未连接所需账号或本地 MCP")
  && !error.message.includes("完成设置"));

const params = { operationId: randomUUID(), sessionKey: randomUUID(), prompt: "Use the plugin",
  createdAt: Date.now(), pluginSelection: [b, a] };
assert.deepEqual(validateChatServiceParams("chat.send", params).pluginSelection, [a, b]);
assert.throws(() => validateChatServiceParams("chat.send", {
  ...params, pluginSelection: [{ ...a, revision: 0 }],
}), { code: "INVALID_PARAMS" });
assert.throws(() => validateChatServiceParams("chat.steer", {
  operationId: params.operationId, sessionKey: params.sessionKey, runId: null,
  message: "Add plugin", createdAt: params.createdAt, pluginSelection: [a],
}), { code: "INVALID_PARAMS" });

console.log("plugin chat selection unit: PASS");
