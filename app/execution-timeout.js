"use strict";

// Inactivity protection is distinct from a task's total running time.
const EXECUTION_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = null;
// Largest portable finite delay accepted by the runtimes and Node timers.
const MAX_EXECUTION_TIMEOUT_MS = 2_147_000_000;

function isExecutionTimeoutMs(value, minimum = 1) {
  return value === null || value === 0
    || Number.isSafeInteger(value) && value >= minimum && value <= MAX_EXECUTION_TIMEOUT_MS;
}

// Public tools use 0; internal waits use null. Never pass either to setTimeout.
function executionTimeoutMs(value, fallback = DEFAULT_EXECUTION_TIMEOUT_MS) {
  return value === undefined ? fallback : value === 0 ? null : value;
}

module.exports = { EXECUTION_TIMEOUT_MS, DEFAULT_EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_TIMEOUT_MS, isExecutionTimeoutMs, executionTimeoutMs };
