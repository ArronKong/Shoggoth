"use strict";

// Only adapter-owned, deterministic contract failures establish incompatibility.
// Timeouts, transport failures, authentication and user configuration do not.
const INCOMPATIBLE_CODES = new Set([
  "RUNTIME_INCOMPATIBLE", "PI_VERSION_UNSUPPORTED",
  "CODEX_RUNTIME_VERSION_MISMATCH", "CODEX_SCHEMA_ERROR", "CODEX_ACCOUNT_PROTOCOL_INVALID",
  "CLAUDE_CODE_VERSION_UNSUPPORTED", "OPENCODE_VERSION_UNSUPPORTED",
  "OPENCODE_PROTOCOL_UNSUPPORTED", "OPENCODE_HTTP_PROTOCOL_INVALID",
  "DEEPSEEK_HARNESS_VERSION_UNSUPPORTED", "DEEPSEEK_HARNESS_PROTOCOL_UNSUPPORTED",
  "GROK_ACP_INITIALIZE_INVALID", "ANTIGRAVITY_ACP_INITIALIZE_INVALID",
  "RUNTIME_PROTOCOL_INVALID", "PI_RPC_RESPONSE_INVALID", "PI_RPC_FRAME_INVALID",
  "PI_RPC_COMMAND_UNSUPPORTED",
]);

function isRuntimeIncompatible(error) {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    try {
      if (INCOMPATIBLE_CODES.has(Object.getOwnPropertyDescriptor(current, "code")?.value)) return true;
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    } catch { return false; }
  }
  return false;
}

module.exports = { isRuntimeIncompatible };
