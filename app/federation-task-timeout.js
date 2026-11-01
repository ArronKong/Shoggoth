"use strict";

const { MAX_EXECUTION_TIMEOUT_MS } = require("./execution-timeout");
const FEDERATION_TASK_MAX_TIMEOUT_MS = MAX_EXECUTION_TIMEOUT_MS;
function validFederationTaskTimeout(value) {
  return value === 0 || Number.isSafeInteger(value) && value >= 5_000 && value <= FEDERATION_TASK_MAX_TIMEOUT_MS;
}
module.exports = { FEDERATION_TASK_MAX_TIMEOUT_MS, validFederationTaskTimeout };
