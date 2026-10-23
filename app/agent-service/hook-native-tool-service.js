"use strict";
const { safeJson, digest, fail, text, keys } = require("./hook-contract");
const { validateHookToolArguments } = require("./hook-tool-schema");
const { PI_BUILTIN_TOOLS, PI_MUTATING_TOOLS, piNativeHookCapabilities } = require("./pi-hook-contract");

// Native callbacks are private Host requests. No model-visible tool or general
// IPC method accepts a model-provided Run, Profile, Host or approval identity.
class HookNativeToolService {
  constructor({ service, toolExecution, getRun, getProfile, getPolicy }) {
    Object.assign(this, { service, toolExecution, getRun, getProfile, getPolicy });
    this.calls = new Map(); this.used = new Map();
  }
  releaseRun(runId) {
    for (const [key, call] of this.calls) if (call.runId === runId) this.calls.delete(key);
    for (const [key, owner] of this.used) if (owner === runId) this.used.delete(key);
  }
  clear() { this.calls.clear(); this.used.clear(); }
  check(scope, snapshot) {
    scope.assertCurrent();
    if (scope.host?.runtime !== "pi") fail("HOOK_RUNTIME_UNSUPPORTED");
    const current = piNativeHookCapabilities(scope.host.host);
    const frozen = snapshot.capabilities.scopes.runtime_builtin.guard;
    if (current.runtime_builtin?.guard.status !== "supported" || frozen.status !== "supported"
      || current.runtime_builtin.guard.extensionDigest !== frozen.extensionDigest
      || current.runtime_builtin.guard.runtimeVersion !== frozen.runtimeVersion) fail("HOOK_RUNTIME_CHANGED");
  }
  async dispatch(input, scope) {
    const request = safeJson(input, 65536);
    if (!["before", "approve", "after"].includes(request.phase) || !text(request.toolCallId, 256)) fail("HOOK_AUTHORITY_INVALID");
    const run = this.getRun(scope.runId), profile = run && this.getProfile(run.profileId);
    if (!run || !profile?.enabled || !["chat", "cron", "kanban", "inspiration"].includes(run.source)) fail("HOOK_FORBIDDEN");
    const snapshot = this.service.store.snapshotForRun(run.id);
    if (!snapshot) fail("HOOK_SNAPSHOT_REQUIRED");
    this.check(scope, snapshot);
    const key = digest([run.id, request.toolCallId]);
    const call = this.calls.get(key);
    if (request.phase === "before") {
      keys(request, ["phase", "toolCallId", "toolName", "arguments", "inputSchema"]);
      if (!PI_BUILTIN_TOOLS.includes(request.toolName) || this.calls.size >= 1024 || this.used.size >= 4096 || this.used.has(key)) fail("HOOK_NATIVE_CALL_CONFLICT");
      this.used.set(key, run.id);
      const policy = this.getPolicy(run.id);
      if (!policy) fail("HOOK_AUTHORITY_INVALID");
      const mutating = PI_MUTATING_TOOLS.has(request.toolName);
      if (mutating && policy.sandbox === "read-only") fail("HOOK_WRITE_FORBIDDEN");
      const assertCurrent = () => { scope.assertCurrent(); this.check(scope, snapshot); };
      const prepared = await this.toolExecution.before({ run, profile,
        tool: { scope: "runtime_builtin", name: request.toolName }, args: request.arguments,
        scope: { ...scope, assertCurrent }, callId: "native-" + key,
        validateArguments: args => validateHookToolArguments(request.inputSchema, args) });
      const nativeApproval = mutating && ["untrusted", "on-failure", "on-request"].includes(policy.approvalPolicy);
      const tool = { scope: "runtime_builtin", name: request.toolName };
      const selected = event => this.service.store.select(snapshot, this.service.event(snapshot, run, event, "native-" + key, {}, tool));
      const after = [...selected("tool.after"), ...selected("tool.result.transform")];
      const response = { arguments: prepared.arguments, requiresApproval: nativeApproval || prepared.requiresApproval,
        needsAfter: after.length > 0, requiredAfter: after.some(entry => entry.definition.kind !== "observe" || entry.definition.required) };
      this.calls.set(key, { runId: run.id, host: scope.host, token: prepared.token,
        response, phase: "prepared", requestDigest: digest(request), assertCurrent });
      // Guards with no following callback still need a bounded approval record.
      if (!response.needsAfter && !response.requiresApproval) this.calls.delete(key);
      return response;
    }
    if (!call || call.host !== scope.host || call.runId !== run.id) fail("HOOK_NATIVE_CALL_CONFLICT");
    call.assertCurrent();
    if (request.phase === "approve") {
      keys(request, ["phase", "toolCallId"]);
      if (call.phase !== "prepared" || !call.response.requiresApproval) fail("HOOK_NATIVE_CALL_CONFLICT");
      call.phase = "approving";
      await this.toolExecution.approve(call.token);
      call.assertCurrent(); call.phase = "approved";
      if (!call.response.needsAfter) this.calls.delete(key);
      return { approved: true };
    }
    keys(request, ["phase", "toolCallId", "result"]);
    if (!call.response.needsAfter || !["prepared", "approved"].includes(call.phase)
      || call.response.requiresApproval && call.phase !== "approved") fail("HOOK_NATIVE_CALL_CONFLICT");
    call.phase = "settling";
    try { return { result: await this.toolExecution.after(call.token, request.result) }; }
    finally { this.calls.delete(key); }
  }
}
module.exports = { HookNativeToolService };
