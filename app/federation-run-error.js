"use strict";

// Only bounded categories cross the federation boundary. Never forward a
// provider's raw error: it can contain credentials, paths or response bodies.
const FEDERATION_RUN_PUBLIC_MESSAGES = Object.freeze({
  AGENT_AUTH_REQUIRED: "目标 Agent 的模型认证失败（HTTP 401 或凭据缺失），请检查该 Agent 使用的 Provider 凭据。",
  AGENT_MODEL_UNAVAILABLE: "目标 Agent 的模型不可用或无法读取当前默认模型，请检查该 Agent 的模型设置。",
  AGENT_QUOTA_EXHAUSTED: "目标 Agent 的模型服务额度不足或触发限流，请检查额度和服务状态。",
  AGENT_CONTEXT_LIMIT: "目标 Agent 的上下文达到限制，请先压缩该会话，再核对任务状态。",
  AGENT_PERMISSION_DENIED: "目标 Agent 的模型服务或执行权限不足，请检查目标 Agent 的授权。",
  AGENT_NETWORK_UNAVAILABLE: "目标 Agent 无法连接模型服务，请检查目标 Agent 的端点和网络。",
});
const FEDERATION_RUN_ERROR_CODES = Object.freeze(Object.keys(FEDERATION_RUN_PUBLIC_MESSAGES));

function federationRunErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (FEDERATION_RUN_ERROR_CODES.includes(code)) return code;
  const message = typeof error === "string" ? error
    : typeof error?.message === "string" ? error.message : error?.errorMessage ?? "";
  const detail = `${code} ${typeof message === "string" ? message.slice(0, 8192) : ""}`;
  if (/AUTH_REQUIRED|AUTHENTICATION_(?:REQUIRED|FAILED)|AuthenticationError|authentication fail|No usable credentials|HTTP\s*401|(?:Error code|status)\s*:\s*401|invalid.*api.?key|missing.*api.?key/iu.test(detail)) return "AGENT_AUTH_REQUIRED";
  if (/MODEL_NOT_FOUND|unknown model|model.*(?:not found|does not exist|unavailable)|unsupported model/iu.test(detail)) return "AGENT_MODEL_UNAVAILABLE";
  if (/QUOTA_EXHAUSTED|SPENDING_LIMIT|insufficient.*(?:quota|credits|balance)|HTTP\s*(?:402|429)|(?:Error code|status)\s*:\s*(?:402|429)/iu.test(detail)) return "AGENT_QUOTA_EXHAUSTED";
  if (/CONTEXT_(?:LENGTH_EXCEEDED|COMPACTION_REQUIRED)|context.*(?:limit|too long|exceed)|maximum context length/iu.test(detail)) return "AGENT_CONTEXT_LIMIT";
  if (/PERMISSION_DENIED|permission denied|HTTP\s*403/iu.test(detail)) return "AGENT_PERMISSION_DENIED";
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ConnectionError|connection (?:refused|failed)/iu.test(detail)) return "AGENT_NETWORK_UNAVAILABLE";
  return "AGENT_OPERATION_FAILED";
}

module.exports = { FEDERATION_RUN_ERROR_CODES, FEDERATION_RUN_PUBLIC_MESSAGES, federationRunErrorCode };
