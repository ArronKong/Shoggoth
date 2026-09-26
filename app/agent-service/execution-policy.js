"use strict";
const { serviceError } = require("./security");

// Each Service-owned native backend has its own execution/background budget.
// OpenClaw and Hermes keep their own schedulers and never enter these budgets.
const limits = { backend: 4, account: 4, backendBackground: 2, profile: 4 };

function resolveAdmissionPolicy(config) {
  if (!config?.flags?.runtimeAdmissionV1) return Object.freeze({ enabled: false, maxActive: 100 });
  if (!Number.isSafeInteger(config.maxActive) || config.maxActive < 1 || config.maxActive > 100) {
    throw serviceError("NATIVE_RUNTIME_CONFIG_INVALID", "原生并发配置无效");
  }
  return Object.freeze({ enabled: true, maxActive: config.maxActive });
}

module.exports = Object.freeze({ ...limits, resolveAdmissionPolicy });
