"use strict";

const { serviceError } = require("./security");
const { validateAgentHarnessResult } = require("./agent-harness-service-protocol");

// Desktop management only. These methods are not Agent/MCP tools.
const COMPUTER_SERVICE_METHODS = Object.freeze(["computer.status", "computer.permissions.request"]);
const COMPUTER_SERVICE_MESSAGES = Object.freeze({
  INVALID_PARAMS: "Computer Use 请求参数无效",
  COMPUTER_SERVICE_UNAVAILABLE: "Computer Use 后台服务暂不可用",
  COMPUTER_DRIVER_UNAVAILABLE: "Computer Use 组件未能加载，请检查 Shoggoth 安装",
  COMPUTER_DRIVER_INVALID: "Computer Use 组件校验失败，请重新安装 Shoggoth",
  COMPUTER_PERMISSION_STATUS_FAILED: "无法读取 Computer Use 系统权限",
  COMPUTER_PERMISSION_REQUEST_FAILED: "无法申请 Computer Use 系统权限",
});

function validateComputerServiceResult(method, value) {
  if (method === "computer.status") {
    try { return validateAgentHarnessResult("harness.computer.status", value); }
    catch { throw serviceError("COMPUTER_PERMISSION_STATUS_FAILED", COMPUTER_SERVICE_MESSAGES.COMPUTER_PERMISSION_STATUS_FAILED); }
  }
  if (method !== "computer.permissions.request" || typeof value?.accessibility !== "boolean"
    || typeof value?.screenRecording !== "boolean") {
    throw serviceError("COMPUTER_PERMISSION_REQUEST_FAILED", COMPUTER_SERVICE_MESSAGES.COMPUTER_PERMISSION_REQUEST_FAILED);
  }
  return { accessibility: value.accessibility, screenRecording: value.screenRecording };
}

async function handleComputerServiceRequest(controller, method, params) {
  if (!COMPUTER_SERVICE_METHODS.includes(method) || !params || typeof params !== "object"
    || Array.isArray(params) || Object.keys(params).length !== 0) {
    throw serviceError("INVALID_PARAMS", COMPUTER_SERVICE_MESSAGES.INVALID_PARAMS);
  }
  if (!controller) throw serviceError("COMPUTER_DRIVER_UNAVAILABLE", COMPUTER_SERVICE_MESSAGES.COMPUTER_DRIVER_UNAVAILABLE);
  return validateComputerServiceResult(method, method === "computer.status"
    ? await controller.status() : await controller.requestPermissions());
}

function mapComputerServiceError(error) {
  const code = Object.hasOwn(COMPUTER_SERVICE_MESSAGES, error?.code || "")
    ? error.code : "COMPUTER_SERVICE_UNAVAILABLE";
  return { code, message: COMPUTER_SERVICE_MESSAGES[code] };
}

module.exports = { COMPUTER_SERVICE_METHODS, handleComputerServiceRequest,
  mapComputerServiceError, validateComputerServiceResult };
