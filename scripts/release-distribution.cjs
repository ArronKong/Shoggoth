"use strict";

// Signing selects the stable application/Keychain identity. Distribution controls
// notarization and auto-update; an internal build can retain Developer ID signing.
function releaseDistribution(mode, requested) {
  if (!["adhoc", "local", "developer-id"].includes(mode)) {
    throw new TypeError("Invalid signing mode");
  }
  const distribution = requested === undefined
    ? (mode === "developer-id" ? "official" : "internal") : requested;
  if (!["official", "internal"].includes(distribution)
    || (distribution === "official" && mode !== "developer-id")) {
    throw new TypeError("Invalid release distribution/signing combination");
  }
  return distribution;
}

module.exports = { releaseDistribution };
