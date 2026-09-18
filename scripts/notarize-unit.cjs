"use strict";

const assert = require("node:assert/strict");
const {
  assertAcceptedReceipt,
  buildNotarytoolArgs,
} = require("./notarize.cjs");

assert.deepEqual(buildNotarytoolArgs(
  "/tmp/Shoggoth-notarization.zip", "shoggoth-release",
), [
  "notarytool", "submit", "/tmp/Shoggoth-notarization.zip",
  "--keychain-profile", "shoggoth-release",
  "--wait", "--output-format", "json",
]);
assert.throws(() => buildNotarytoolArgs("relative.zip", "shoggoth-release"), TypeError);
assert.throws(() => buildNotarytoolArgs("/tmp/release.zip", "bad profile"), TypeError);
assert.deepEqual(assertAcceptedReceipt(JSON.stringify({
  id: "12345678-1234-1234-1234-123456789abc", status: "Accepted", message: "Package Approved",
})), {
  id: "12345678-1234-1234-1234-123456789abc", status: "Accepted", message: "Package Approved",
});
assert.throws(() => assertAcceptedReceipt(JSON.stringify({
  id: "12345678-1234-1234-1234-123456789abc", status: "Invalid",
})), /NOTARIZATION_REJECTED/u);
assert.throws(() => assertAcceptedReceipt("not-json"), /NOTARIZATION_RECEIPT_INVALID/u);

console.log("Developer ID notarization contract unit: PASS (6 checks)");
