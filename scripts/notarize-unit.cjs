"use strict";

const assert = require("node:assert/strict");
const {
  assertAcceptedReceipt,
  buildNotarytoolArgs,
} = require("./notarize.cjs");

assert.deepEqual(buildNotarytoolArgs(
  "/tmp/Shoggoth-notarization.zip", "shoggoth-release", "/tmp/release.keychain-db",
), [
  "notarytool", "submit", "/tmp/Shoggoth-notarization.zip",
  "--keychain-profile", "shoggoth-release",
  "--keychain", "/tmp/release.keychain-db",
  "--wait", "--output-format", "json",
]);
assert.throws(() => buildNotarytoolArgs("relative.zip", "shoggoth-release"), TypeError);
assert.throws(() => buildNotarytoolArgs("/tmp/release.zip", "bad profile"), TypeError);
assert.throws(() => buildNotarytoolArgs("/tmp/release.zip", "release", "relative.keychain-db"), TypeError);
assert.deepEqual(assertAcceptedReceipt(JSON.stringify({
  id: "12345678-1234-1234-1234-123456789abc", status: "Accepted", message: "Package Approved",
})), {
  id: "12345678-1234-1234-1234-123456789abc", status: "Accepted", message: "Package Approved",
});
assert.throws(() => assertAcceptedReceipt(JSON.stringify({
  id: "12345678-1234-1234-1234-123456789abc", status: "Invalid",
})), /NOTARIZATION_REJECTED/u);
assert.throws(() => assertAcceptedReceipt("not-json"), /NOTARIZATION_RECEIPT_INVALID/u);

const { releaseDistribution } = require("./release-distribution.cjs");
assert.equal(releaseDistribution("developer-id"), "official");
assert.equal(releaseDistribution("developer-id", "internal"), "internal");
assert.equal(releaseDistribution("adhoc"), "internal");
assert.throws(() => releaseDistribution("developer-id", "typo"), TypeError);
assert.throws(() => releaseDistribution("adhoc", "official"), TypeError);
const keys = ["SHOGGOTH_CODESIGN_MODE", "SHOGGOTH_RELEASE_DISTRIBUTION", "SHOGGOTH_NOTARY_KEYCHAIN_PROFILE"];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  process.env.SHOGGOTH_CODESIGN_MODE = "developer-id";
  delete process.env.SHOGGOTH_NOTARY_KEYCHAIN_PROFILE;
  delete process.env.SHOGGOTH_RELEASE_DISTRIBUTION;
  const notarize = require("./notarize.cjs").default;
  assert.throws(() => notarize({ electronPlatformName: "darwin" }), /requires SHOGGOTH_NOTARY/u);
  process.env.SHOGGOTH_RELEASE_DISTRIBUTION = "internal";
  assert.doesNotThrow(() => notarize({ electronPlatformName: "darwin" }));
  process.env.SHOGGOTH_NOTARY_KEYCHAIN_PROFILE = "must-not-submit";
  assert.throws(() => notarize({ electronPlatformName: "darwin" }), /Internal builds must not/u);
} finally {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

console.log("Developer ID notarization and internal distribution contract: PASS");
