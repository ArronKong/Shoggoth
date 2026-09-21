"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function buildNotarytoolArgs(archivePath, keychainProfile, keychainPath) {
  if (!path.isAbsolute(archivePath) || !PROFILE_PATTERN.test(keychainProfile || "")) {
    throw new TypeError("notarization archive/profile is invalid");
  }
  if (keychainPath !== undefined
    && (!path.isAbsolute(keychainPath) || keychainPath.includes("\0"))) {
    throw new TypeError("notarization keychain path is invalid");
  }
  const args = [
    "notarytool", "submit", archivePath,
    "--keychain-profile", keychainProfile,
  ];
  if (keychainPath) args.push("--keychain", keychainPath);
  args.push("--wait", "--output-format", "json");
  return args;
}

function assertAcceptedReceipt(stdout) {
  let receipt;
  try { receipt = JSON.parse(stdout); } catch { throw new Error("NOTARIZATION_RECEIPT_INVALID"); }
  if (!receipt || receipt.status !== "Accepted"
    || typeof receipt.id !== "string" || !/^[A-Fa-f0-9-]{16,64}$/u.test(receipt.id)) {
    throw new Error("NOTARIZATION_REJECTED");
  }
  return { id: receipt.id, status: receipt.status, message: receipt.message || null };
}

exports.default = function notarize(context) {
  if (context.electronPlatformName !== "darwin") return;
  const mode = process.env.SHOGGOTH_CODESIGN_MODE
    || (process.env.SHOGGOTH_CODESIGN_IDENTITY ? "local" : "adhoc");
  const keychainProfile = process.env.SHOGGOTH_NOTARY_KEYCHAIN_PROFILE;
  const keychainPath = process.env.SHOGGOTH_NOTARY_KEYCHAIN;
  if (!keychainProfile) {
    if (mode === "developer-id") {
      throw new Error("Developer ID release requires SHOGGOTH_NOTARY_KEYCHAIN_PROFILE");
    }
    console.log("  • notarization skipped (internal preview)");
    return;
  }
  if (mode !== "developer-id" || !PROFILE_PATTERN.test(keychainProfile)) {
    throw new TypeError("Notarization requires Developer ID mode and a valid keychain profile");
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-notary-"));
  try {
    const archivePath = path.join(scratch, "Shoggoth-notarization.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, archivePath], {
      stdio: "ignore", timeout: 180_000,
    });
    const stdout = execFileSync("/usr/bin/xcrun", buildNotarytoolArgs(archivePath, keychainProfile, keychainPath), {
      encoding: "utf8", timeout: 30 * 60_000,
    });
    const receipt = assertAcceptedReceipt(stdout);
    execFileSync("/usr/bin/xcrun", ["stapler", "staple", appPath], {
      stdio: "inherit", timeout: 180_000,
    });
    execFileSync("/usr/bin/xcrun", ["stapler", "validate", appPath], {
      stdio: "inherit", timeout: 60_000,
    });
    execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
      stdio: "inherit", timeout: 60_000,
    });
    fs.writeFileSync(`${appPath}.notarization.json`, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8", mode: 0o600,
    });
    console.log(`  • notarized and stapled  ${appPath} (${receipt.id})`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

exports.PROFILE_PATTERN = PROFILE_PATTERN;
exports.assertAcceptedReceipt = assertAcceptedReceipt;
exports.buildNotarytoolArgs = buildNotarytoolArgs;
