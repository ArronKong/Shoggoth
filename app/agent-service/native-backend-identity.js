"use strict";

const { id: NATIVE_BACKEND_ID, agentPrefixes } = require("../native-backend-catalog.json");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");

function claimsNativeAgentId(agentId) {
  return typeof agentId === "string" && agentPrefixes.some(prefix => agentId.startsWith(prefix));
}

function isNativeBindingDisabled(_agentId, runtime, disabledIds, runtimeAccountId) {
  if (runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID) return false;
  return Array.isArray(disabledIds) && disabledIds.includes(runtime);
}

module.exports = { NATIVE_BACKEND_ID, claimsNativeAgentId, isNativeBindingDisabled };
