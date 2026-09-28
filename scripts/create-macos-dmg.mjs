#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/create-macos-dmg.mjs --arch arm64|x64 --distribution internal|official [--dist path]";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

const arch = option("--arch");
const distribution = option("--distribution");
const distOption = option("--dist");
if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch)
  || !["internal", "official"].includes(distribution)
  || process.argv.length !== (distOption ? 8 : 6)) {
  throw new Error(usage);
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/u);
const dist = distOption ? path.resolve(distOption) : path.join(root, "dist");
const app = path.join(dist, arch === "arm64" ? "mac-arm64" : "mac", "Shoggoth.app");
const executable = path.join(app, "Contents", "MacOS", "Shoggoth");
const version = execFileSync("/usr/libexec/PlistBuddy", [
  "-c", "Print :CFBundleShortVersionString", path.join(app, "Contents", "Info.plist"),
], { encoding: "utf8" }).trim();
assert.equal(version, packageJson.version, "App version differs from package.json");

const marker = JSON.parse(await readFile(path.join(app, "Contents", "Resources", "shoggoth-release.json"), "utf8"));
assert.equal(marker.version, version, "release marker version differs from App");
assert.equal(marker.distribution, distribution, "release marker distribution differs from requested DMG");
if (distribution === "official") assert.equal(marker.signingMode, "developer-id");

const expectedArch = arch === "x64" ? "x86_64" : "arm64";
const actualArchs = execFileSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" }).trim().split(/\s+/u);
assert.deepEqual(actualArchs, [expectedArch], "App executable has an unexpected architecture");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit", timeout: 180_000 });

mkdirSync(dist, { recursive: true });
const dmgName = `Shoggoth-${version}-${arch}.dmg`;
const destination = path.join(dist, dmgName);
assert.equal(existsSync(destination), false, `${dmgName} already exists`);

const scratch = mkdtempSync(path.join(os.tmpdir(), "shoggoth-dmg-"));
try {
  const payload = path.join(scratch, "payload");
  mkdirSync(payload);
  const payloadApp = path.join(payload, "Shoggoth.app");
  // On APFS, clone the signed bundle without allocating a second full App.
  // Preserve permissions, symlinks and extended attributes, then verify the
  // copied signature and ticket before using it as the DMG input.
  execFileSync("/bin/cp", ["-cRp", app, payloadApp], {
    stdio: "inherit", timeout: 15 * 60_000,
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", payloadApp], {
    stdio: "inherit", timeout: 180_000,
  });
  if (distribution === "official") {
    execFileSync("/usr/bin/xcrun", ["stapler", "validate", payloadApp], {
      stdio: "inherit", timeout: 60_000,
    });
  }
  symlinkSync("/Applications", path.join(payload, "Applications"));
  const temporaryDmg = path.join(scratch, dmgName);
  execFileSync("/usr/bin/hdiutil", [
    "create", "-format", "UDZO", "-volname", `Shoggoth ${arch}`,
    "-srcfolder", payload, temporaryDmg,
  ], { stdio: "inherit", timeout: 20 * 60_000 });
  execFileSync("/usr/bin/hdiutil", ["verify", temporaryDmg], {
    stdio: "inherit", timeout: 10 * 60_000,
  });
  assert.ok(lstatSync(temporaryDmg).size > 1_000_000, "DMG is unexpectedly small");
  renameSync(temporaryDmg, destination);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const hash = createHash("sha256");
for await (const chunk of createReadStream(destination)) hash.update(chunk);
console.log(JSON.stringify({ artifact: destination, arch, distribution, version, sha256: hash.digest("hex") }));
