"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

function hasEnabledEntitlement(display, entitlement) {
  const escapedName = entitlement.replaceAll(".", "\\.");
  const xml = /^(?:<\?xml\b|<plist\b)[\s\S]*?<\/plist>/mu.exec(display)?.[0];
  if (xml) {
    const result = spawnSync("/usr/bin/plutil", ["-extract", escapedName, "raw", "-expect", "bool", "-o", "-", "--", "-"], {
      input: xml, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    });
    return result.status === 0 && !result.error && result.stdout.trim() === "true";
  }
  const entry = new RegExp(`^\\t\\[Key\\] ${escapedName}\\r?\\n\\t\\[Value\\]\\r?\\n\\t\\t\\[Bool\\] true\\r?$`, "mu");
  return /^\[Dict\]\r?$/mu.test(display) && entry.test(display);
}

function verifyPackagedRendererSignature(appPath, architecture) {
  const executableName = "Shoggoth Helper (Renderer)";
  const executable = path.join(appPath, "Contents", "Frameworks", `${executableName}.app`,
    "Contents", "MacOS", executableName);
  const args = ["-d", "--verbose=4", "--entitlements", "-"];
  if (architecture) args.push("--arch", architecture);
  const { status, stdout, stderr, error } = spawnSync("/usr/bin/codesign", [...args, executable], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const fail = message => { throw new Error(`PACKAGED_RENDERER_SIGNATURE_INVALID: ${executable}: ${message}`); };
  if (status !== 0 || error) fail("could not inspect the executable signature");
  if (!/^Identifier=ai\.shoggoth\.desktop\.helper\.Renderer$/mu.test(stderr)) fail("unexpected code signing identifier");
  if (!/^CodeDirectory .*\bflags=0x[\da-f]+\([^\n)]*\bruntime\b/imu.test(stderr)) fail("hardened runtime is required");

  // Older codesign releases display XML. Newer releases can display DER
  // entitlements directly, so do not request legacy XML output explicitly.
  for (const key of ["allow-jit", "allow-unsigned-executable-memory"]) {
    const entitlement = `com.apple.security.cs.${key}`;
    if (!hasEnabledEntitlement(stdout.trim() || stderr, entitlement)) fail(`missing enabled ${entitlement} entitlement`);
  }
  return executable;
}

if (require.main === module) {
  const [, , appPath] = process.argv;
  if (process.argv.length !== 3 || !path.isAbsolute(appPath || "")) {
    console.error("Usage: node scripts/packaged-renderer-signature.cjs /absolute/path/to/Shoggoth.app");
    process.exitCode = 2;
  } else {
    try {
      verifyPackagedRendererSignature(appPath);
      console.log("PASS packaged Renderer helper hardened runtime and JIT entitlements");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { hasEnabledEntitlement, verifyPackagedRendererSignature };
