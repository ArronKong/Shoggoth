"use strict";

const assert = require("node:assert/strict");
const {
  defaultRuntimePermissionMode,
  resolveRuntimePermissionMode,
  runtimePermissionModeOptions,
  CHAT_PERMISSION_MODES,
  adapterPermissionMode,
  initialRuntimePermissionMode,
} = require("../app/agent-service/runtime-permission-modes");

const ids = (runtime) => runtimePermissionModeOptions(runtime).map((option) => option.id);

const runtimes = ["codex", "claude-code", "grok-build", "antigravity", "pi", "opencode", "deepseek-harness"];
for (const runtime of runtimes) {
  assert.deepEqual(ids(runtime), Object.values(CHAT_PERMISSION_MODES));
  assert.deepEqual(runtimePermissionModeOptions(runtime).map(option => option.label),
    ["Request approval", "Approve for me", "Full access"]);
  const description = runtimePermissionModeOptions(runtime).find(option => option.id === CHAT_PERMISSION_MODES.auto).description;
  assert.equal(description, ["antigravity", "pi", "opencode", "deepseek-harness"].includes(runtime)
    ? "Automatically run workspace files and commands in a sandbox; ask before wider access."
    : "Review actions automatically and ask you when needed.",
  `${runtime} describes the approval reviewer it actually provides`);
  for (const mode of Object.values(CHAT_PERMISSION_MODES)) {
    const resolved = resolveRuntimePermissionMode(runtime, mode, {});
    assert.equal(resolved.mode, mode, "Switching Runtime preserves the selected product mode");
    assert.equal(resolved.permissionPolicy.sandbox,
      runtime === "opencode" || mode === CHAT_PERMISSION_MODES.full ? "danger-full-access" : "workspace-write");
    assert.equal(runtimePermissionModeOptions(runtime).find(option => option.id === mode).requiresConfirmation === true,
      mode === CHAT_PERMISSION_MODES.full);
  }
  assert.equal(initialRuntimePermissionMode(runtime), CHAT_PERMISSION_MODES.auto,
    `${runtime} starts new chat sessions in Approve for me`);
}
assert.equal(adapterPermissionMode("claude-code", CHAT_PERMISSION_MODES.ask), "default");
assert.equal(adapterPermissionMode("grok-build", CHAT_PERMISSION_MODES.full), "always-approve");
assert.equal(adapterPermissionMode("antigravity", CHAT_PERMISSION_MODES.auto), "auto-review");
assert.equal(adapterPermissionMode("deepseek-harness", CHAT_PERMISSION_MODES.auto), "workspace-write");
assert.equal(resolveRuntimePermissionMode("codex", CHAT_PERMISSION_MODES.auto, {}).nativeMode, "auto_review");
for (const runtime of ["codex", "pi", "antigravity", "claude-code"]) {
  const mode = ["codex", "pi"].includes(runtime) ? "read-only" : "plan";
  assert.equal(resolveRuntimePermissionMode(runtime, mode, {}).permissionPolicy.sandbox, "read-only");
}

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

for (const [mode, sandbox] of [["full", "danger-full-access"], ["workspace-auto", "workspace-write"]]) {
  const inherited = { approvalPolicy: "never", sandbox };
  for (const requested of [mode, null]) {
    const resolved = resolveRuntimePermissionMode("codex", requested, inherited);
    assert.equal(resolved.mode, mode); assert.equal(resolved.nativeMode, mode);
    assert.deepEqual(resolved.permissionPolicy, { approvalPolicy: "on-request", sandbox },
      "Codex must forward internal MCP binding elicitation without changing its sandbox");
    assert.deepEqual(resolveRuntimePermissionMode("pi", requested, inherited).permissionPolicy, inherited);
  }
  assert.deepEqual(inherited, { approvalPolicy: "never", sandbox }, "Profile policy is not mutated");
}

const futurePolicy = { approvalPolicy: "on-failure", sandbox: "workspace-write" };
assert.deepEqual(runtimePermissionModeOptions("future"), []);
assert.equal(initialRuntimePermissionMode("future"), null);
assert.deepEqual(resolveRuntimePermissionMode("future", null, futurePolicy).permissionPolicy, futurePolicy);
assert.throws(
  () => resolveRuntimePermissionMode("codex", "not-a-mode", futurePolicy),
  (error) => error.code === "CHAT_SESSION_PERMISSION_INVALID",
);

// Codex refuses every MCP elicitation under "never", including the helper's per-call binding
// proof, so every Codex mode and inherited profile policy must keep asking ("on-request") while
// keeping its sandbox. Other runtimes have no such constraint and keep "never".
const never = { approvalPolicy: "never", sandbox: "workspace-write" };
assert.deepEqual(resolveRuntimePermissionMode("codex", "full", never).permissionPolicy,
  { approvalPolicy: "on-request", sandbox: "danger-full-access" });
assert.deepEqual(resolveRuntimePermissionMode("codex", "workspace-auto", never).permissionPolicy,
  { approvalPolicy: "on-request", sandbox: "workspace-write" });
assert.deepEqual(resolveRuntimePermissionMode("codex", "read-only", never).permissionPolicy,
  { approvalPolicy: "on-request", sandbox: "read-only" });
assert.deepEqual(resolveRuntimePermissionMode("codex", null, never).permissionPolicy,
  { approvalPolicy: "on-request", sandbox: "workspace-write" }, "an inherited never must not reach Codex");
assert.deepEqual(resolveRuntimePermissionMode("pi", "full", never).permissionPolicy,
  { approvalPolicy: "never", sandbox: "danger-full-access" });
assert.deepEqual(resolveRuntimePermissionMode("pi", "workspace-auto", never).permissionPolicy,
  { approvalPolicy: "never", sandbox: "workspace-write" });

console.log("PASS runtime permission catalogs and policy mappings");
