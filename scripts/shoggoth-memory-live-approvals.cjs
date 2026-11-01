"use strict";

// Acceptance interaction driver, never installed in the production Service.
const crypto = require("node:crypto");
const { validateMemoryMcpArguments } = require("../app/agent-service/memory-mcp-tools");
const allowed = new Set(["memory_search", "memory_get", "memory_explain", "conversation_search", "conversation_get", "memory_save", "memory_forget"]);
const fail = () => Object.assign(new Error("MEMORY_LIVE_UNEXPECTED_APPROVAL"), { code: "MEMORY_LIVE_UNEXPECTED_APPROVAL" });
function memoryApprovalTool(record, run, scope) {
  if (scope.runtime !== "grok-build" || record?.kind !== "approval" || record.settled
    || record.runId !== scope.runId || run?.id !== scope.runId || run.profileId !== scope.profileId
    || run.source !== "chat" || run.sourceId !== scope.sessionKey || run.status !== "waiting_approval"
    || run.waitingRequestId !== record.requestId || record.publicPayload?.redacted === true
    || record.method !== "item/commandExecution/requestApproval"
    || !record.params.approvalOptions?.some(option => option.choice === "once" && option.kind === "allow_once")) return null;
  const input = record.params.toolInput;
  if (!input || Object.keys(input).some(key => !["variant", "tool_name", "tool_input"].includes(key))) return null;
  const name = typeof input.tool_name === "string" && input.tool_name.startsWith("shoggoth__")
    ? input.tool_name.slice("shoggoth__".length) : null;
  // Native ACP names the resolved MCP tool. File invocation forms cannot
  // enter this driver: only the exact inline arguments are accepted.
  if (record.params.toolName !== input.tool_name
    || input.variant !== undefined && (typeof input.variant !== "string" || input.variant.length > 64)) return null;
  const args = input.tool_input;
  if (!allowed.has(name) || !args || args.source !== "chat" || args.sourceId !== scope.sessionKey) return null;
  // Historical reads remain inside the known synthetic owning Agent's
  // sessions. A model-supplied foreign session never receives an approval.
  if (["conversation_search", "conversation_get"].includes(name) && args.sessionId !== undefined
    && !scope.allowedSessionIds?.includes(args.sessionId)) return null;
  const { activityTitle, ...toolArgs } = args;
  if (activityTitle !== undefined && (typeof activityTitle !== "string" || activityTitle.length > 512)) return null;
  return validateMemoryMcpArguments(name, toolArgs) ? name : null;
}
function watchMemoryApprovals(coordinator, scope, evidence) {
  let stopped = false, running = false, rejectFailure;
  const seen = new Set(), failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (const record of coordinator.pendingRequests.values()) {
        if (record.runId !== scope.runId || seen.has(record.requestId)) continue;
        const tool = memoryApprovalTool(record, coordinator.dispatcher.getRun(scope.runId), scope);
        if (!tool || seen.size >= 256) {
          const run = coordinator.dispatcher.getRun(scope.runId), input = record.params?.toolInput, args = input?.tool_input;
          evidence.push({ runId: scope.runId, status: "rejected", shape: {
            kind: record.kind === "approval" ? "approval" : "other", settled: record.settled === true,
            profileMatches: run?.profileId === scope.profileId, sourceMatches: run?.sourceId === scope.sessionKey,
            sourceChat: run?.source === "chat", waiting: run?.status === "waiting_approval", requestMatches: run?.waitingRequestId === record.requestId,
            redacted: record.publicPayload?.redacted === true, commandMethod: record.method === "item/commandExecution/requestApproval",
            useTool: record.params?.toolName === "use_tool", onceAvailable: record.params?.approvalOptions?.some(option => option.choice === "once" && option.kind === "allow_once") === true,
            tool: [...allowed].find(name => input?.tool_name === `shoggoth__${name}`) || "other",
            toolNameAbsent: record.params?.toolName === undefined,
            toolNameMatchesMemory: record.params?.toolName === input?.tool_name,
            inputKeys: ["variant", "tool_name", "tool_input"].filter(name => input && Object.hasOwn(input, name)),
            unknownInputKeys: input && typeof input === "object" ? Object.keys(input).filter(name => !["variant", "tool_name", "tool_input"].includes(name)).length : null,
            argumentSourceChat: args?.source === "chat", argumentSourceMatches: args?.sourceId === scope.sessionKey,
            argumentKeys: ["source", "sourceId", "query", "maxResults", "memoryScope", "activityTitle", "expectedRevision", "content", "scope", "classification", "sourceQuote", "supersedes", "sessionId", "eventId", "limit", "window"].filter(name => args && Object.hasOwn(args, name)),
          } });
          throw fail();
        }
        seen.add(record.requestId);
        await coordinator.respondApproval({ operationId: crypto.randomUUID(), runId: scope.runId,
          requestId: record.requestId, choice: "once" });
        evidence.push({ runId: scope.runId, tool, choice: "once" });
      }
    } catch (error) { stopped = true; rejectFailure(error); }
    finally { running = false; }
  };
  const timer = setInterval(tick, 50); timer.unref();
  // The first native request may precede the send acknowledgement.
  queueMicrotask(tick);
  return { failure, stop() { stopped = true; clearInterval(timer); } };
}
module.exports = { memoryApprovalTool, watchMemoryApprovals };
