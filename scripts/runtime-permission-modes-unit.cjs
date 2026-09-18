"use strict";

const assert = require("node:assert/strict");
const {
  defaultRuntimePermissionMode,
  resolveRuntimePermissionMode,
  runtimePermissionModeOptions,
} = require("../app/agent-service/runtime-permission-modes");

const ids = (runtime) => runtimePermissionModeOptions(runtime).map((option) => option.id);

assert.deepEqual(ids("codex"), ["read-only", "ask", "workspace-auto", "full"]);
assert.deepEqual(ids("grok-build"), ["ask", "auto", "always-approve"]);
assert.deepEqual(ids("antigravity"), ["plan", "accept-edits", "full"]);
assert.deepEqual(ids("pi"), ["read-only", "ask", "workspace-auto", "full"]);
assert.deepEqual(ids("claude-code"), ["default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"]);
assert.deepEqual(ids("deepseek-harness"), ["workspace-write", "danger-full-access"]);

const defaultPolicy = { approvalPolicy: "on-request", sandbox: "danger-full-access" };
for (const runtime of [
  "codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness",
]) {
  assert.deepEqual(resolveRuntimePermissionMode(runtime, null, defaultPolicy).permissionPolicy,
    defaultPolicy, `${runtime} should inherit the profile permission policy`);
}
assert.equal(resolveRuntimePermissionMode("deepseek-harness", null, defaultPolicy).nativeMode,
  "danger-full-access");

assert.deepEqual(resolveRuntimePermissionMode("grok-build", "auto", {
  approvalPolicy: "on-request", sandbox: "read-only",
}).permissionPolicy, {
  approvalPolicy: "on-request", sandbox: "read-only",
});
assert.equal(resolveRuntimePermissionMode("grok-build", "always-approve", {
  approvalPolicy: "on-request", sandbox: "workspace-write",
}).nativeMode, "bypassPermissions");
assert.deepEqual(resolveRuntimePermissionMode("claude-code", "dontAsk", {}).permissionPolicy, {
  approvalPolicy: "untrusted", sandbox: "workspace-write",
});
assert.deepEqual(resolveRuntimePermissionMode("claude-code", "acceptEdits", {}).permissionPolicy, {
  approvalPolicy: "on-request", sandbox: "workspace-write",
});
assert.equal(defaultRuntimePermissionMode("deepseek-harness", {
  approvalPolicy: "never", sandbox: "danger-full-access",
}), "danger-full-access");

const futurePolicy = { approvalPolicy: "on-failure", sandbox: "workspace-write" };
assert.deepEqual(runtimePermissionModeOptions("future"), []);
assert.deepEqual(resolveRuntimePermissionMode("future", null, futurePolicy).permissionPolicy, futurePolicy);
assert.throws(
  () => resolveRuntimePermissionMode("codex", "not-a-mode", futurePolicy),
  (error) => error.code === "CHAT_SESSION_PERMISSION_INVALID",
);

console.log("PASS runtime permission catalogs and policy mappings");
