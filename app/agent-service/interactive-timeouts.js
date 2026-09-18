"use strict";

const {
  mcpElicitationUsesApprovalWait,
} = require("../core/shoggoth-interaction-contract");

// 审批与普通输入是两种不同的等待契约：审批跟随当前 Runtime 生命周期持续等待，
// 普通输入仍有有限窗口，避免无人处理的表单长期占用一次工具调用。
const DEFAULT_APPROVAL_TIMEOUT_MS = null;
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = DEFAULT_PROMPT_TIMEOUT_MS + 30_000;
// Codex, Claude Code and DeepSeek Harness require a finite positive MCP tool
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
