"use strict";
// Only Supervisor constructs this gate around its captured physical writer.
// A callback result is not a public readiness/authority protocol.
const { plain, fail } = require("./managed-openclaw-model-policy");
function createManagedProviderCredentialFinishGate(callbacks) {
  const keys = ["assertCurrent", "resumeVerified", "settleVerified", "pauseVerified", "holdUnverified"];
  if (!plain(callbacks) || Reflect.ownKeys(callbacks).length !== keys.length || keys.some(key => typeof callbacks[key] !== "function")) {
    throw fail("MANAGED_MODEL_CREDENTIAL_FINISH_INVALID");
  }
  const trusted = Object.freeze({ ...callbacks });
  let attempted = false, complete = false;
  const check = () => { if (trusted.assertCurrent() !== true) throw fail("MANAGED_MODEL_CREDENTIAL_FINISH_RETIRED"); };
  async function pauseUnknown() {
    let verified = false;
    try { verified = await trusted.pauseVerified() === true; } catch { /* exact owner may be unavailable; never adopt or invent pause */ }
    try { await trusted.holdUnverified(verified); } catch { /* do not publish caller error bodies or a false completion */ }
    return verified;
  }
  return Object.freeze({
    async finish(outcome) {
      if (attempted || !["applied", "compensated", "blocked"].includes(outcome)) throw fail("MANAGED_MODEL_CREDENTIAL_FINISH_UNKNOWN");
      attempted = true;
      try {
        check(); if (await trusted.resumeVerified() !== true) throw fail("MANAGED_MODEL_CREDENTIAL_RESUME_UNVERIFIED"); check();
        if (await trusted.settleVerified(outcome) !== true) throw fail("MANAGED_MODEL_CREDENTIAL_SETTLE_UNVERIFIED"); check();
        complete = true; return true;
      } catch {
        await pauseUnknown(); throw fail("MANAGED_MODEL_CREDENTIAL_FINISH_UNKNOWN");
      }
    },
    // A later local cancellation can withdraw a just-verified effect. It may
    // pause only the same captured owner, never resume or resend settlement.
    async withdraw() { complete = false; await pauseUnknown(); return false; },
    isComplete: () => complete,
  });
}
module.exports = { createManagedProviderCredentialFinishGate };
