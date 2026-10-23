"use strict";
const { HOOK_EVENTS, HOOK_TOOL_SCOPES, fail } = require("./hook-contract");
const TARGETS = Object.freeze(["codex-harness", "codex", "claude-code", "pi", "opencode", "deepseek-harness", "grok-build", "antigravity"]);
function runtimeHookCapabilities(runtime, native = {}) {
  return { schemaVersion: 1, runtime, scopes: Object.fromEntries(HOOK_TOOL_SCOPES.map(scope => [
    scope, Object.fromEntries(["observe", "guard", "arguments", "action", "result"].map(kind => [kind,
      ["product", "native_mcp", "plugin_mcp"].includes(scope)
        ? { status: "supported", owner: "service", evidence: "hook-tool-execution-v1" }
        : native[scope]?.[kind] || { status: "unsupported", reason: "RUNTIME_HOOK_BRIDGE_UNAVAILABLE" }]))])),
    events: Object.fromEntries(Object.keys(HOOK_EVENTS).map(event => [event,
      ["model.request.before", "model.request.after", "context.native_compacted", "subagent.started", "subagent.finished"].includes(event)
        ? { status: "unsupported", reason: "RUNTIME_EVENT_BRIDGE_UNAVAILABLE" } : { status: "supported", owner: "service" }])) };
}
function assertHookSupported(definition, capabilities, processHost) {
  if (capabilities.events[definition.event]?.status !== "supported") fail("HOOK_EVENT_UNSUPPORTED");
  if (definition.event.startsWith("tool.")) {
    const kind = definition.kind === "guard" ? "guard" : definition.kind === "action" ? "action"
      : definition.event === "tool.result.transform" ? "result" : definition.kind === "observe" ? "observe" : "arguments";
    if (kind && definition.matcher.toolScopes.some(scope => capabilities.scopes[scope]?.[kind]?.status !== "supported")) fail("HOOK_RUNTIME_UNSUPPORTED");
  }
  if ((definition.handler.type === "script" || ["context.file", "workspace.copy"].includes(definition.handler.name))
    && !processHost?.available(definition.handler.language || "javascript")) fail("HOOK_SANDBOX_UNAVAILABLE");
}
class RuntimeHookBridge {
  constructor({ service, resolveAssignment }) { this.service = service; this.resolveAssignment = resolveAssignment; }
  async dispatch(request, hostContext) {
    if (!hostContext || typeof hostContext.assertCurrent !== "function" || !hostContext.runId
      || !request || !["before", "approve", "after"].includes(request.phase)) fail("HOOK_AUTHORITY_INVALID");
    const assignment = this.resolveAssignment(hostContext.runId);
    if (!assignment || assignment.host !== hostContext.host || assignment.bindingId !== hostContext.bindingId) fail("HOOK_AUTHORITY_INVALID");
    hostContext.assertCurrent();
    if (typeof this.service.runtimeToolEvent !== "function") fail("HOOK_RUNTIME_UNSUPPORTED");
    const result = await this.service.runtimeToolEvent(request, hostContext);
    hostContext.assertCurrent(); return result;
  }
}
module.exports = { RuntimeHookBridge, runtimeHookCapabilities, assertHookSupported, HOOK_RUNTIME_TARGETS: TARGETS };
