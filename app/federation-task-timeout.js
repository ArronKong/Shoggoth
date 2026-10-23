"use strict";

const { EXECUTION_TIMEOUT_MS } = require("./execution-timeout");

// Both current asynchronous tasks and the legacy synchronous entry point use
// the existing finite execution budget. Native tasks keep their Runtime policy.
const FEDERATION_TASK_MAX_TIMEOUT_MS = EXECUTION_TIMEOUT_MS;

module.exports = { FEDERATION_TASK_MAX_TIMEOUT_MS };
