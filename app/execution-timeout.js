"use strict";

// Shared budget for executions and human waits that already had a deadline.
// Lifecycle-bound waits remain unbounded; transport deadlines may add reply grace.
const EXECUTION_TIMEOUT_MS = 30 * 60_000;

module.exports = { EXECUTION_TIMEOUT_MS };
