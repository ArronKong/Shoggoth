"use strict";

// Cold verification of the bundled Codex can exceed 20 seconds. Keep every
// layer bounded, with room for parent verify/describe (60 + 20s), App identity
// (20 + 20s), service authentication (20s), and process startup overhead.
const CODEX_PARENT_VERIFY_TIMEOUT_MS = 60_000;
const CODEX_MCP_STARTUP_TIMEOUT_SEC = 150;
const CODEX_SESSION_START_TIMEOUT_MS = 180_000;

module.exports = {
  CODEX_PARENT_VERIFY_TIMEOUT_MS,
  CODEX_MCP_STARTUP_TIMEOUT_SEC,
  CODEX_SESSION_START_TIMEOUT_MS,
};
