"use strict";

const {
  mcpElicitationUsesApprovalWait,
} = require("../core/shoggoth-interaction-contract");
// Human input and approvals live until answered, canceled, or their owning
// runtime/connection ends. They do not have an elapsed-time deadline.
const DEFAULT_APPROVAL_TIMEOUT_MS = null;
const DEFAULT_PROMPT_TIMEOUT_MS = null;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = null;
// Codex, Claude Code and DeepSeek require a finite positive MCP tool
// timeout. Use a near-maximum portable JS timer delay so their outer tool deadline
// does not turn a user approval wait into a short timeout; Runtime cancellation
// and process teardown remain the actual lifecycle boundary.
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 2_147_000_000;
const DEFAULT_MCP_TOOL_TIMEOUT_SEC = Math.floor(DEFAULT_MCP_TOOL_TIMEOUT_MS / 1_000);

const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

function isApprovalRequestMethod(method) {
  return APPROVAL_REQUEST_METHODS.has(method);
}

function serverRequestUsesApprovalWait(method, params) {
  if (isApprovalRequestMethod(method)) return true;
  if (method !== "mcpServer/elicitation/request") return false;
  return mcpElicitationUsesApprovalWait({
    ...params,
    method,
    kind: "mcp_elicitation",
  });
}

module.exports = {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_SEC,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
  isApprovalRequestMethod,
  serverRequestUsesApprovalWait,
};
