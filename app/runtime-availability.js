"use strict";

// Release policy is independent of persisted account/profile schemas. Disabling
// an integration must not delete existing conversations or native CLI data.
const { disabledRuntimes } = require("./release-policy.json");
const disabled = new Set(disabledRuntimes);

function isRuntimeAvailable(runtime) {
  return !disabled.has(runtime);
}

module.exports = { isRuntimeAvailable };
