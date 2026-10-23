"use strict";
// The Supervisor constructs this once from its retained original finish. A
// caller cannot choose an outcome, extend credential authority or replay a write.
const { plain, fail } = require("./managed-openclaw-model-policy");
function createManagedProviderTerminalRecoveryGate(callbacks) {
  const functions = ["assertCurrent", "observeVerified", "resumeVerified", "pauseVerified", "holdUnverified"];
  if (!plain(callbacks) || Reflect.ownKeys(callbacks).length !== functions.length
    || functions.some(key => typeof callbacks[key] !== "function")) throw fail("MANAGED_MODEL_TERMINAL_RECOVERY_INVALID");
  const trusted = Object.freeze({ ...callbacks });
  let attempted = false, complete = false;
  const check = () => { if (trusted.assertCurrent() !== true) throw fail("MANAGED_MODEL_TERMINAL_RECOVERY_RETIRED"); };
  async function pauseUnknown() {
    let verified = false;
    try { verified = await trusted.pauseVerified() === true; } catch { /* Never adopt a replacement or invent pause. */ }
    try { await trusted.holdUnverified(verified); } catch { /* Keep the original unverified result. */ }
  }
  return Object.freeze({
    async recover() {
      if (attempted) throw fail("MANAGED_MODEL_TERMINAL_RECOVERY_UNKNOWN");
      attempted = true;
      try {
        check(); if (await trusted.observeVerified("paused") !== true) throw fail("MANAGED_MODEL_TERMINAL_OBSERVATION_UNVERIFIED"); check();
        if (await trusted.resumeVerified() !== true) throw fail("MANAGED_MODEL_TERMINAL_RESUME_UNVERIFIED"); check();
        if (await trusted.observeVerified("resumed") !== true) throw fail("MANAGED_MODEL_TERMINAL_OBSERVATION_UNVERIFIED"); check();
        complete = true; return true;
      } catch {
        await pauseUnknown(); throw fail("MANAGED_MODEL_TERMINAL_RECOVERY_UNKNOWN");
      }
    },
    async withdraw() { complete = false; await pauseUnknown(); return false; },
    isComplete: () => complete,
  });
}
module.exports = { createManagedProviderTerminalRecoveryGate };
